/* 事实检索（M1+M2 状态机）：EXACT → ALIAS → PARTIAL → SEMANTIC_CANDIDATE → NO_RESULT。
 * 纯本地检索（M1 结构化；M2 语义兜底 = 确定性哈希嵌入 + 余弦，无模型无网络）。
 * 铁律：只返回真实记录；结构化命中永远优先于语义（AD-21）；检索不到 → NO_RESULT，绝不编造数值。
 */
const { matchMetric, partialMatch } = require("./metrics");
const { lookup, lookupIndicator } = require("./index");
const { semanticTopK } = require("./semantic");

const STATE_EXACT = "EXACT";
const STATE_ALIAS = "ALIAS";
const STATE_PARTIAL = "PARTIAL";
const STATE_SEMANTIC = "SEMANTIC_CANDIDATE";
const STATE_NO_RESULT = "NO_RESULT";

/* 语义兜底仅接受足够强的近似（余弦 ≥ 阈值），避免“人名/数量”等弱子串重叠产生
 * 误导性候选 —— 检索不到就是 NO_RESULT，绝不把不相关指标当成候选（铁律）。 */
const SEMANTIC_MIN_SCORE = 0.5;

function scoreFact(rec, dim1, dim2) {
  let s = 0;
  if (dim1) {
    if (rec.dimension_1 === dim1) s += 10;
  } else {
    s += 1; // 未限定维度1：任何记录都可作为可用值
  }
  if (dim2) {
    if (rec.dimension_2 === dim2) s += 8;
    else if (dim2 === "累计" && rec.dimension_2 === "累计") s += 8;
    else if (/^\d{4}-\d{2}$/.test(dim2) && /^\d{4}-\d{2}$/.test(rec.dimension_2) && rec.dimension_2.slice(0, 4) === dim2.slice(0, 4)) s += 2;
  } else if (rec.dimension_2 === "累计") {
    s += 4; // 无日期时优先累计值
  }
  if (rec.indicator_desc) s += 1;
  return s;
}

function toFactItem(rec, matchType) {
  return {
    indicator_id: rec.indicator_id || null,
    indicator_name: rec.indicator_name,
    indicator_value: rec.indicator_value,
    indicator_target: rec.indicator_target != null ? rec.indicator_target : null,
    indicator_unit: rec.indicator_unit || null,
    indicator_desc: rec.indicator_desc || null,
    dimension_1: rec.dimension_1 || null,
    dimension_2: rec.dimension_2 || null,
    match_type: matchType,
    source: {
      file: rec.source_file,
      sheet: rec.source_sheet || null,
      row: rec.source_row != null ? rec.source_row : null,
    },
  };
}

/* 指标解析：返回 { name, type, note }；type ∈ exact|alias|partial|null */
function resolveMetric(resolved, metricNames) {
  const raw = resolved.metric_raw || resolved.metric_candidate || resolved.metric_name || null;
  if (!raw) return { name: null, type: null, note: "无指标" };
  if (metricNames.includes(raw)) return { name: raw, type: "exact", note: "" };
  const al = matchMetric(raw);
  if (al.name && metricNames.includes(al.name)) return { name: al.name, type: "alias", note: "" };
  const p = partialMatch(raw, metricNames);
  if (p) return { name: p, type: "partial", note: "部分匹配：" + p };
  return { name: null, type: null, note: "指标不在字典：" + raw };
}

/* 检索入口：resolved = { metric_raw|metric_candidate|metric_name, dim1, data_date, semantic, semanticK };
 * 返回 { state, note, facts, resolved } */
function retrieve(index, resolved) {
  const indicatorNames = index.indicatorNames;
  const dim1 = resolved.dim1 || null;
  const dim2 = resolved.data_date || null;
  // 语义阈值可配置（对应 web search.score_threshold；默认 0.5 防噪声）
  const minScore = resolved.semanticMinScore != null ? resolved.semanticMinScore : SEMANTIC_MIN_SCORE;

  const mr = resolveMetric(resolved, indicatorNames);
  let mName = mr.name;
  let mType = mr.type;
  let metricNote = mr.note;
  let semanticHits = null;

  // 结构化失败 → 语义兜底（默认开启；结构化永远优先）
  if (!mName && resolved.semantic !== false && index.semanticIndex) {
    const q = resolved.metric_raw || resolved.metric_candidate || resolved.metric_name || "";
    const top = semanticTopK(q, index.semanticIndex, resolved.semanticK || 3).filter((t) => t.score >= minScore);
    if (top.length) {
      semanticHits = top;
      mType = "semantic";
      mName = top[0].name;
      metricNote = "语义候选（近似匹配·纯本地）：" + top.map((t) => t.surface).join("/") + "（top-" + top.length + "）";
    } else {
      const all = semanticTopK(q, index.semanticIndex, resolved.semanticK || 3);
      metricNote = all.length
        ? "语义近似不足（最高 " + all[0].score.toFixed(2) + " 低于阈值 " + minScore.toFixed(2) + "）：" + q
        : "语义层未命中：" + q;
    }
  }
  if (!mName) return { state: STATE_NO_RESULT, note: metricNote || "指标未命中", facts: [], resolved };

  // 候选集
  let pool = [];
  if (semanticHits) {
    const seenName = new Set();
    for (const t of semanticHits) {
      if (seenName.has(t.name)) continue;
      seenName.add(t.name);
      const recs = lookupIndicator(index, t.name);
      if (!recs.length) continue;
      const boost = t.score * 2; // 语义相似度加成（结构化得分仍占主导）
      for (const rec of recs) pool.push({ rec, score: scoreFact(rec, dim1, dim2) + boost });
    }
    pool.sort((a, b) => b.score - a.score);
    if (!pool.length) return { state: STATE_NO_RESULT, note: "语义候选命中但无真实数据记录", facts: [], resolved };
  } else if (dim1 && dim2) {
    pool = lookup(index, dim1, mName, dim2)
      .map((rec) => ({ rec, score: scoreFact(rec, dim1, dim2) }))
      .sort((a, b) => b.score - a.score);
    if (!pool.length) {
      const indicatorPool = lookupIndicator(index, mName);
      if (indicatorPool.length) {
        pool = indicatorPool.map((rec) => ({ rec, score: scoreFact(rec, dim1, dim2) })).sort((a, b) => b.score - a.score);
      } else {
        return { state: STATE_NO_RESULT, note: "无真实数据记录（指标：" + mName + "）", facts: [], resolved };
      }
    }
  } else {
    const indicatorPool = lookupIndicator(index, mName);
    if (!indicatorPool.length) return { state: STATE_NO_RESULT, note: "无真实数据记录（指标：" + mName + "）", facts: [], resolved };
    pool = indicatorPool.map((rec) => ({ rec, score: scoreFact(rec, dim1, dim2) })).sort((a, b) => b.score - a.score);
  }

  // 组 top 事实（按 维度1|维度2 去重，取前三）
  const seen = new Set();
  const top = [];
  for (const x of pool) {
    const rec = x.rec;
    const k = (rec.dimension_1 || "") + "|" + (rec.dimension_2 || "");
    if (seen.has(k)) continue;
    seen.add(k);
    top.push(toFactItem(rec, mType));
    if (top.length >= 3) break;
  }
  if (!top.length) return { state: STATE_NO_RESULT, note: metricNote || "无结果", facts: [], resolved };

  /* 回填解析结果：后续渲染（弹窗维度）与测试断言直接读取 resolved。 */
  resolved.metric_name = mName;
  resolved.metric_match_type = mType;
  if (metricNote) resolved.metric_note = metricNote;

  let state = STATE_EXACT;
  if (mType === "alias") state = STATE_ALIAS;
  else if (mType === "partial") state = STATE_PARTIAL;
  else if (mType === "semantic") state = STATE_SEMANTIC;

  const noteBits = [];
  const best = top[0];
  if (dim1 && best.dimension_1 !== dim1) noteBits.push("维度1未能精确命中，返回同名指标的可用记录");
  if (!dim1) noteBits.push("未限定维度1，返回可用记录");
  if (dim2 && best.dimension_2 !== dim2) noteBits.push("维度2未能精确命中，返回最接近的记录");
  if (!dim2) noteBits.push("未限定维度2，优先累计值");
  if (metricNote) noteBits.push(metricNote);
  return { state, note: noteBits.join("；"), facts: top, resolved };
}

module.exports = {
  retrieve,
  scoreFact,
  toFactItem,
  resolveMetric,
  STATES: { STATE_EXACT, STATE_ALIAS, STATE_PARTIAL, STATE_SEMANTIC, STATE_NO_RESULT },
};
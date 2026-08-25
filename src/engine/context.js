/* 通用报告上下文分析（M1，禁 LLM）：动态维度匹配 + 日期/标题 Hint。
 * 不再硬编码门店/城市，改为扫描文本中所有已知 dimension_1 值。
 * 保留日期匹配逻辑（dimension_2 通常为时间维度）。 */
const { normalizeMetric, ALIASES, matchMetric, partialMatch } = require("./metrics");

const MONTH_RE = /(\d{4})[-年/](\d{1,2})月?/;

/* 别名词表（长→短），用于在文本中直接扫描别名 token。 */
const ALIAS_TOKENS = Object.keys(ALIASES).sort((a, b) => b.length - a.length);

/* 通用维度值匹配：全名包含 > 去后缀≥3字包含。禁子序列/禁短尾误配。 */
const _DIM_SUFFIX_RE = /(店|公司|中心|广场|门店|分公司|集团|有限|股份|省|市|区|县|州|国)$/;
const _DIM_MIN_STRICT = 3;

function dimMatchStrict(dimValue, text) {
  if (!dimValue || !text) return false;
  if (text.includes(dimValue)) return true;
  const s2 = dimValue.replace(_DIM_SUFFIX_RE, "");
  if (s2.length >= _DIM_MIN_STRICT && text.includes(s2)) return true;
  return false;
}

/* 向后兼容别名 */
const storeMatchStrict = dimMatchStrict;

function pad2(n) { return String(parseInt(n, 10)).padStart(2, "0"); }

function firstLine(text) {
  const i = text.indexOf("\n");
  return i < 0 ? text.trim() : text.slice(0, i).trim();
}

/* 分析整篇：返回 { title, dim1, dim1_scope, data_date, date_scope, missing }
 * dim1Values: 所有已知 dimension_1 值（如国家名、公司名、门店名等） */
function analyzeContext(text, dim1Values) {
  const ctx = {
    title: firstLine(text),
    dim1: null,
    dim1_scope: null,
    data_date: null,
    date_scope: null,
    missing: [],
  };
  const m = text.match(MONTH_RE);
  if (m) {
    ctx.data_date = m[1] + "-" + pad2(m[2]);
    ctx.date_scope = "document";
  } else if (/累计|年度|全年/.test(text) && !/本月|当月/.test(text)) {
    ctx.data_date = "累计";
    ctx.date_scope = "document";
  }
  // 维度1：优先标题，其次正文；严格匹配（全名包含 > 去后缀≥3字包含）
  const sorted = [...dim1Values].sort((a, b) => b.length - a.length);
  const hay = ctx.title.length >= 2 ? ctx.title : text.slice(0, 200);
  for (const s of sorted) {
    if (dimMatchStrict(s, hay)) { ctx.dim1 = s; ctx.dim1_scope = ctx.title.length >= 2 && ctx.title.includes(s) ? "title" : "document"; break; }
  }
  if (!ctx.dim1) {
    for (const s of sorted) {
      if (dimMatchStrict(s, text)) { ctx.dim1 = s; ctx.dim1_scope = "document"; break; }
    }
  }
  if (!ctx.dim1) ctx.missing.push("dim1");
  if (!ctx.data_date) ctx.missing.push("data_date");
  return ctx;
}

/* 日期就近绑定 */
const _DATE_SPAN_RE = /(?<ym>(?<y1>20\d{2})[-/年.](?<m1>\d{1,2})\s*月?)|(?<y>(?<y2>20\d{2})\s*年)|(?<m>(?<m2>\d{1,2})\s*月)/g;

function _dateFromSpan(m) {
  if (m.groups && m.groups.ym) {
    const y = m.groups.y1, mo = String(parseInt(m.groups.m1, 10)).padStart(2, "0");
    return { date: y + "-" + mo, pos: m.index, end: m.index + m[0].length };
  }
  if (m.groups && m.groups.y) {
    return { date: m.groups.y2 + "-01", pos: m.index, end: m.index + m[0].length };
  }
  if (m.groups && m.groups.m) {
    const now = new Date();
    const y = String(now.getFullYear());
    const mo = String(parseInt(m.groups.m2, 10)).padStart(2, "0");
    return { date: y + "-" + mo, pos: m.index, end: m.index + m[0].length };
  }
  return null;
}

function _nearestDate(text, anchor) {
  _DATE_SPAN_RE.lastIndex = 0;
  const hits = [];
  let m;
  while ((m = _DATE_SPAN_RE.exec(text))) {
    const d = _dateFromSpan(m);
    if (d) hits.push(d);
  }
  if (!hits.length) return null;
  let left = null, right = null;
  for (const h of hits) {
    if (h.end <= anchor) { if (!left || h.end > left.end) left = h; }
    else if (h.pos >= anchor) { if (!right || h.pos < right.pos) right = h; }
  }
  return (left || right || hits[0]).date;
}

/* 单条请求解析：句子/段落内 维度1（句子>段落>文档）、日期（就近绑定） */
function resolveLocals(sentence, paragraph, docCtx, dim1Values, anchorPos) {
  const out = { dim1: null, dim1_scope: null, data_date: null, date_scope: null, missing: [] };
  const sorted = [...dim1Values].sort((a, b) => b.length - a.length);
  for (const s of sorted) {
    if (dimMatchStrict(s, sentence)) { out.dim1 = s; out.dim1_scope = "sentence"; break; }
  }
  if (!out.dim1 && paragraph) {
    for (const s of sorted) {
      if (dimMatchStrict(s, paragraph)) { out.dim1 = s; out.dim1_scope = "paragraph"; break; }
    }
  }
  if (!out.dim1 && docCtx.dim1) { out.dim1 = docCtx.dim1; out.dim1_scope = docCtx.dim1_scope || "document"; }
  if (!out.dim1) out.missing.push("dim1");

  const m = sentence.match(MONTH_RE);
  if (m) { out.data_date = m[1] + "-" + pad2(m[2]); out.date_scope = "sentence"; }
  else if (/累计|年度|全年/.test(sentence) && !/本月|当月/.test(sentence)) { out.data_date = "累计"; out.date_scope = "sentence"; }
  if (!out.data_date && anchorPos != null) {
    const nd = _nearestDate(sentence + "\n" + (paragraph || ""), anchorPos);
    if (nd) { out.data_date = nd; out.date_scope = "nearest"; }
  }
  if (!out.data_date && docCtx.data_date) { out.data_date = docCtx.data_date; out.date_scope = docCtx.date_scope || "document"; }
  if (!out.data_date) out.missing.push("data_date");
  return out;
}

/* 在文本片段中定位指标：精确（字典名）→ 别名表扫描 → 部分匹配。 */
function extractMetricToken(sentence, metricNames) {
  const candidates = metricNames.slice().sort((a, b) => b.length - a.length);
  // 1) 精确：字典名直接出现在片段中（长→短，避免子串误配）
  for (const name of candidates) {
    const idx = sentence.indexOf(name);
    if (idx >= 0) return { token: name, index: idx, end: idx + name.length, name, match_type: "exact" };
  }
  // 2) 别名表扫描：片段中出现任一别名词 → 其目标指标（若在字典中）
  for (const tok of ALIAS_TOKENS) {
    const idx = sentence.indexOf(tok);
    if (idx >= 0) {
      const name = ALIASES[tok];
      if (metricNames.includes(name)) return { token: tok, index: idx, end: idx + tok.length, name, match_type: "alias" };
    }
  }
  // 3) 部分匹配：整段去尾部虚词后，与字典名互相包含（长度 ≥2）
  const core = sentence.replace(/[为是达至了，。：:、\s]+$/g, "");
  if (core.length >= 2) {
    const p = partialMatch(core, metricNames);
    if (p) {
      const idx = sentence.indexOf(p);
      return { token: core, index: idx >= 0 ? idx : 0, end: idx >= 0 ? idx + p.length : p.length, name: p, match_type: "partial" };
    }
  }
  // 4) 兜底：单字别名/近似（如“试驾”）
  const al = matchMetric(core);
  if (al.name && metricNames.includes(al.name) && al.match_type !== "unmatched") {
    return { token: core, index: 0, end: core.length, name: al.name, match_type: "alias" };
  }
  return null;
}

function hasValueAfter(sentence, endIdx) {
  const tail = sentence.slice(endIdx);
  return /\d/.test(tail.slice(0, 12));
}

/* 占位符左侧的语义近义段：句段起点 = 上一个句号/换行之后；
 * lead = 去掉句段首尾标点/空白后，紧邻占位符的连续中英文数字串（用于语义兜底查询）。 */
function placeholderLead(text, placeholderIdx) {
  const start = Math.max(0, text.lastIndexOf("。", placeholderIdx), text.lastIndexOf("\n", placeholderIdx));
  const seg = text.slice(start, placeholderIdx);
  let lead = seg
    .replace(/^[^A-Za-z0-9\u4e00-\u9fa5]+/g, "")
    .replace(/[^A-Za-z0-9\u4e00-\u9fa5]+$/g, "");
  lead = lead
    .replace(/^(本月|上月|本季度|上季度|本年度|上年度|今年|去年|当月|当季|本周|上周)/g, "")
    .replace(/[为是达至了，。：:、\s]+$/g, "");
  return { seg, lead };
}

/* A 类专用：取“紧邻占位符左侧最近”的指标命中（精确名/别名词 lastIndexOf，选 end 最接近占位符者）。 */
function metricRightBefore(text, placeholderIdx, metricNames) {
  const { seg } = placeholderLead(text, placeholderIdx);
  if (!seg) return null;
  const hits = [];
  for (const name of metricNames) {
    const i = seg.lastIndexOf(name);
    if (i >= 0) hits.push({ token: name, name, end: i + name.length, match_type: "exact" });
  }
  for (const tok of ALIAS_TOKENS) {
    const i = seg.lastIndexOf(tok);
    if (i >= 0) {
      const name = ALIASES[tok];
      if (metricNames.includes(name)) hits.push({ token: tok, name, end: i + tok.length, match_type: "alias" });
    }
  }
  hits.sort((a, b) => b.end - a.end);
  return hits.length ? hits[0] : null;
}

module.exports = { analyzeContext, resolveLocals, extractMetricToken, metricRightBefore, placeholderLead, hasValueAfter, firstLine, storeMatchStrict, dimMatchStrict };
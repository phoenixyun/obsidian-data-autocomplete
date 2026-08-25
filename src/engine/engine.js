/* 编排层（M1 无外部服务、无 LLM）：
 * 上下文分析 → 请求检测 → 逐请求解析与检索 → 输出与 /analyze-report 同形状。
 */
const { buildIndex, lookup, lookupIndicator } = require("./index");
const { analyzeContext, resolveLocals } = require("./context");
const { detectRequests } = require("./detector");
const { retrieve } = require("./retrieval");
const { normalizeMetric } = require("./metrics");
const { buildSemanticIndex } = require("./semantic");

function paragraphAt(text, idx) {
  let start = text.lastIndexOf("\n\n", idx);
  if (start < 0) start = -2;
  start += 2;
  let end = text.indexOf("\n\n", idx);
  if (end < 0) end = text.length;
  return text.slice(start, end).trim();
}

class Engine {
  constructor() {
    this.index = null;
  }

  /* 用解析后的记录重建内存索引 + 指标语义索引。records 可直接来自 parser.parseWorkbook。 */
  rebuild(records) {
    this.index = buildIndex(records);
    this.index.semanticIndex = buildSemanticIndex(this.index.indicatorNames);
    return this.index.stats();
  }

  isReady() {
    return !!this.index && this.index.total > 0;
  }

  stats() {
    return this.index ? this.index.stats() : { record_count: 0, dim1_count: 0, indicator_count: 0 };
  }

  /* 同 Python /analyze-report 返回形状：
   * { document_id, context, data_requests:[{ request_id, request, resolved, result }], analysis_time_ms }
   */
  analyze(text, opts = {}) {
    const t0 = Date.now();
    if (!this.isReady()) {
      return {
        document_id: opts.document_id || null,
        context: { error: "索引未构建" },
        data_requests: [],
        analysis_time_ms: Date.now() - t0,
      };
    }
    const indicatorNames = this.index.indicatorNames;
    const context = analyzeContext(text, this.index.dim1Values);
    const requests = detectRequests(text, indicatorNames, { detectMetricWithoutValue: opts.detectMetricWithoutValue });

    const data_requests = requests.map((req, i) => {
      const paragraph = paragraphAt(text, req.sentence_pos ? req.sentence_pos[0] : 0);
      /* 日期就近绑定锚点：占位符位置（A 类）或指标位置（B 类） */
      const anchorPos =
        req.placeholder_pos && req.placeholder_pos[0] != null
          ? req.placeholder_pos[0]
          : req.metric_pos && req.metric_pos[0] != null
            ? req.metric_pos[0]
            : null;
      const locals = resolveLocals(req.sentence || text, paragraph, context, this.index.dim1Values, anchorPos);
      const resolved = {
        metric_raw: req.metric_candidate || null,
        metric_candidate: req.metric_candidate || null,
        metric_name: req.metric_name ? normalizeMetric(req.metric_name) : null,
        metric_match_type: req.metric_match_type || null,
        dim1: locals.dim1,
        dim1_scope: locals.dim1_scope,
        data_date: locals.data_date,
        date_scope: locals.date_scope,
        missing: locals.missing,
        semantic: opts.semantic !== false,
        semanticK: opts.semanticK || 3,
        semanticMinScore: opts.semanticMinScore != null ? opts.semanticMinScore : 0.5,
      };
      const result = retrieve(this.index, resolved);
      return {
        request_id: req.request_id || "r" + (i + 1),
        request: req,
        resolved,
        result,
      };
    });

    return {
      document_id: opts.document_id || null,
      context,
      data_requests,
      analysis_time_ms: Date.now() - t0,
    };
  }

  /* M3 内联补全入口：对“光标前句段”复用完整链路（请求检测→解析→检索），
   * 返回 top 事实候选或 NO_RESULT。segment 为光标所在行占位符之前的部分（应已去掉末尾未闭合的【）。
   */
  suggest(segment, opts = {}) {
    if (!this.isReady()) return null;
    const probe = segment + "【待补充】";
    const r = this.analyze(probe, opts);
    const dr = r.data_requests.find(
      (d) => d.request.kind === "placeholder" && d.request.placeholder_pos && d.request.placeholder_pos[0] >= segment.length
    );
    return dr ? dr.result : null;
  }

  /* 手动搜索（对齐网页版 SearchService）：
   * 查询理解（门店/指标/日期）→ 元数据 narrowing → 排序（baseline / keyword_boost / vector_pure）。
   * 纯本地实现：无向量模型时用指标名相似度近似 vector 权重。
   */
  search(query, opts = {}) {
    if (!this.isReady()) return { understood: null, results: [] };
    const variant = opts.variant || "baseline";
    const text = query || "";

    /* 1) 查询理解：复用上下文解析（维度1严格匹配 + 日期就近绑定 + 指标匹配） */
    const ctx = analyzeContext(text, this.index.dim1Values);
    const indicatorNames = this.index.indicatorNames;
    const reqs = detectRequests(text, indicatorNames, { detectMetricWithoutValue: false });
    const req = reqs[0] || null;
    const locals = req
      ? resolveLocals(req.sentence || text, text, ctx, this.index.dim1Values, null)
      : { dim1: ctx.dim1, dim1_scope: ctx.dim1_scope, data_date: ctx.data_date, date_scope: ctx.date_scope, missing: [] };
    const indicatorName = req && req.metric_name ? normalizeMetric(req.metric_name) : null;

    /* 2) 元数据 narrowing：维度1 + 指标 + 维度2 精确过滤 */
    let pool = this.index.records;
    if (locals.dim1) pool = pool.filter((r) => r.dimension_1 === locals.dim1);
    if (indicatorName) pool = pool.filter((r) => r.indicator_name === indicatorName);
    if (locals.data_date && locals.data_date !== "累计") pool = pool.filter((r) => r.dimension_2 === locals.data_date);

    /* 3) 排序：baseline（维度1/指标/维度2命中加权） / keyword_boost（关键词命中加权） / vector_pure（指标名相似度） */
    const kw = text.toLowerCase();
    const scored = pool.map((r) => {
      let score = 0;
      if (variant === "vector_pure") {
        /* 无向量模型：用指标名包含度近似 */
        score = indicatorName && r.indicator_name === indicatorName ? 1 : indicatorName && r.indicator_name.includes(indicatorName) ? 0.6 : 0.2;
      } else {
        if (locals.dim1 && r.dimension_1 === locals.dim1) score += 3;
        if (indicatorName && r.indicator_name === indicatorName) score += 3;
        if (locals.data_date && r.dimension_2 === locals.data_date) score += 2;
        if (variant === "keyword_boost") {
          const hay = (r.indicator_name + " " + (r.dimension_1 || "") + " " + (r.dimension_2 || "")).toLowerCase();
          if (hay.includes(kw)) score += 2;
        }
      }
      return { rec: r, score };
    });
    scored.sort((a, b) => b.score - a.score);
    const results = scored.slice(0, opts.limit || 20).map((s) => s.rec);

    return {
      understood: [locals.dim1, indicatorName, locals.data_date].filter(Boolean).join(" / ") || "（未解析出维度）",
      results,
    };
  }
}

module.exports = { Engine, buildIndex, lookup, lookupIndicator, normalizeMetric };
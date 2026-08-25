/* 数据请求检测（M1，对齐网页版 data_request_detector.py）：
 * A) 占位符：【待补充】 / {{x}} / [x]        → HIGH（0.9）
 * B) 指标缺值：句中出现指标名，紧跟其后 12 字符内无数值 → MED（0.6）
 * C) 隐含意图：默认关闭（与 Python 版一致）   → LOW（0.35）
 * 置信度分级：exact 0.9 / alias 0.8 / partial 0.55 / 无命中 0.3-0.4。
 */
const { extractMetricToken, metricRightBefore, placeholderLead, hasValueAfter } = require("./context");

/* 占位符内容为通用填充词（待补充/数据/数值…）时，指标词才取“占位符左侧近义段”；否则占位符内容本身就是指标意图。 */
const FILLER_TOKENS = new Set(["待补充", "待填", "待补", "待写", "补充", "数据", "数值", "数字", "值", "TBD", "xxx", "...", "…"]);

/* Bug 2 修复：`[x]` 占位符正则此前会误匹配 Markdown 链接 `[示例笔记](...)`。
 * 排除链接形式：`[内容](url)` 或 `[内容][ref]` 不当作占位符。 */
const PLACEHOLDER_RES = [
  /【([^】]{1,40})】/g,
  /\{\{([^{}]{1,40})\}\}/g,
  /\[([^\]\n]{1,40})\](?!\s*[\(\[])/g,
  /（([^）]{1,40}待补充[^）]{0,20})）/g,
];

/* B 类缺值句法：指标后紧跟这些动词/标点且无数字/占位符（对齐网页版 _METRIC_NO_VALUE_RE）。 */
const METRIC_NO_VALUE_RE = /^(?:达到|达|为|是|约|上升至|下降至|增长至|维持在|保持)/;

/* C 类隐式意图模式（默认关闭，对齐网页版 _IMPLICIT_PATTERNS）。 */
const IMPLICIT_PATTERNS = [
  /(?:需要|要|请)(?:补充|补|填)(?:一下|一)?\s*(.{1,10}?)\s*(?:数据|值|指标)/,
  /补(?:充|一下|上)\s*(.{1,10}?)\s*(?:数据|值)/,
  /(.{1,10}?)\s*(?:数据|值|指标)\s*(?:是|为)?\s*(?:多少|几)/,
];

function sentenceAt(text, idx) {
  let start = text.lastIndexOf("。", idx);
  const nl = text.lastIndexOf("\n", idx);
  if (nl > start) start = nl;
  start += 1;
  let end = text.indexOf("。", idx);
  if (end < 0) end = text.length;
  return text.slice(start, end).trim();
}

function posOf(text, idx) {
  let start = text.lastIndexOf("。", idx);
  const nl = text.lastIndexOf("\n", idx);
  if (nl > start) start = nl;
  start += 1;
  let end = text.indexOf("。", idx);
  if (end < 0) end = text.length;
  return [start, end];
}

/* B 类：逐句检测“指标名出现却紧跟无数值”。
 * 对齐网页版：指标名后紧跟动词白名单（达到/达/为/是/约/上升至/下降至/增长至/维持在/保持）
 * 且其后 12 字符内无数值 → 判定缺值。普通描述（“试驾量表现较好”）不触发。
 * 输出带文档偏移 metric_pos（句内命中位置换算到全文），供编辑器画波浪线/Tab 补全。 */
function detectMissingValue(text, metricNames) {
  const out = [];
  const sentenceChars = ["。", "！", "？", "；", "\n"];
  let start = 0;
  for (let end = 0; end <= text.length; end++) {
    if (end === text.length || sentenceChars.includes(text[end])) {
      const raw = text.slice(start, end);
      const sent = raw.trim();
      if (sent) {
        const head = raw.length - raw.trimStart().length; // 句首空白偏移（trim 后与全文对齐）
        const sentStart = start + head;
        /* 句内含占位符（【/{{/[x]/（待补充））时，由 A 类占位符检测负责，避免重复计数 */
        if (!/[【]|\{\{|\[[^\]\n]{0,12}\]|（[^）]{0,20}待补充/.test(sent)) {
          const hit = extractMetricToken(sent, metricNames);
          if (hit) {
            /* 指标名后紧跟的片段（去空白后）：
             *  - 无后续内容（句子结束，如「本月试驾量」）→ 直接判定缺值
             *  - 有后续内容 → 必须以动词白名单开头（如「成交率为」），且 12 字符内无数值
             * 普通描述（「试驾量表现较好」）不触发。 */
            const after = sent.slice(hit.end).replace(/^[\s，,：:、]+/, "");
            const verbOk = after === "" || METRIC_NO_VALUE_RE.test(after);
            if (verbOk && !hasValueAfter(sent, hit.end)) {
              out.push({
                kind: "metric_no_value",
                sentence: sent,
                sentence_pos: [sentStart, sentStart + sent.length],
                metric_pos: [sentStart + hit.index, sentStart + hit.end],
                metric_candidate: hit.token,
                metric_name: hit.name,
                metric_match_type: hit.match_type,
                confidence: hit.match_type === "exact" ? 0.7 : hit.match_type === "alias" ? 0.6 : 0.45,
                confidence_label: hit.match_type === "exact" ? "HIGH" : hit.match_type === "alias" ? "MEDIUM" : "LOW",
                source: "指标缺值检测",
              });
            }
          }
        }
      }
      start = end + 1;
    }
  }
  return out;
}

/* opts.detectMetricWithoutValue===false 时关闭 B 类缺值检测（对应 web autocomplete.detect_metric_without_value）。 */
function detectRequests(text, metricNames, opts = {}) {
  const requests = [];
  let seq = 0;
  // A) 占位符
  for (const re of PLACEHOLDER_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      seq++;
      const content = (m[1] || "").trim();
      /* 指标词优先取自占位符紧邻左侧最近的指标命中（如“成交量为【待补充】”）；
       * 结构化未命中时，用句段近义段 lead 作语义兜底查询词（如“到店人数为【待补充】”→ lead=“到店人数”）。 */
      let hit = metricRightBefore(text, m.index, metricNames);
      if (!hit && content) hit = extractMetricToken(content, metricNames);
      const lead = placeholderLead(text, m.index).lead;
      /* 候选词优先级：结构化命中 > 占位符内指标词（非填充词）> 占位符左侧近义段 > 占位符内容 */
      let candidate;
      if (hit) candidate = hit.token;
      else if (content && !FILLER_TOKENS.has(content)) candidate = content;
      else candidate = lead || content || null;
      requests.push({
        request_id: "r" + seq,
        kind: "placeholder",
        placeholder: m[0],
        placeholder_pos: [m.index, m.index + m[0].length],
        sentence: sentenceAt(text, m.index),
        sentence_pos: posOf(text, m.index),
        paragraph_pos: [Math.max(0, text.lastIndexOf("\n\n", m.index)), -1],
        metric_candidate: candidate || null,
        metric_name: hit ? hit.name : null,
        metric_match_type: hit ? hit.match_type : null,
        confidence: hit ? (hit.match_type === "exact" ? 0.9 : hit.match_type === "alias" ? 0.8 : 0.55) : (content ? 0.4 : 0.3),
        confidence_label: hit ? (hit.match_type === "exact" ? "HIGH" : hit.match_type === "alias" ? "HIGH" : "LOW") : "LOW",
        source: "占位符模式",
      });
    }
  }
  // B) 指标缺值（可关：opts.detectMetricWithoutValue === false）
  if (opts.detectMetricWithoutValue !== false) {
    for (const mm of detectMissingValue(text, metricNames)) {
      seq++;
      requests.push(Object.assign({ request_id: "r" + seq }, mm));
    }
  }
  // C) 隐式意图（默认关闭：opts.detectImplicitIntent === true 才启用，对齐网页版）
  if (opts.detectImplicitIntent) {
    for (const pat of IMPLICIT_PATTERNS) {
      pat.lastIndex = 0;
      let m;
      while ((m = pat.exec(text))) {
        seq++;
        const content = (m[1] || "").trim();
        const hit = content ? extractMetricToken(content, metricNames) : null;
        requests.push({
          request_id: "r" + seq,
          kind: "implicit_intent",
          placeholder: null,
          placeholder_pos: null,
          sentence: sentenceAt(text, m.index),
          sentence_pos: posOf(text, m.index),
          paragraph_pos: [Math.max(0, text.lastIndexOf("\n\n", m.index)), -1],
          metric_candidate: content || null,
          metric_name: hit ? hit.name : null,
          metric_match_type: hit ? hit.match_type : null,
          confidence: hit ? 0.5 : 0.35,
          confidence_label: hit ? "MEDIUM" : "LOW",
          source: "隐式意图检测",
        });
      }
    }
  }
  requests.sort((a, b) => (a.sentence_pos && b.sentence_pos ? a.sentence_pos[0] - b.sentence_pos[0] : 0));
  return requests;
}

module.exports = { detectRequests, detectMissingValue };
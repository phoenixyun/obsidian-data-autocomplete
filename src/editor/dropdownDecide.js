/* Navicat 式下拉的纯判定层：不依赖 CodeMirror/Obsidian，可脱离编辑器单元测试。
 * 决定当前光标处应弹出什么下拉：
 *   1) 占位符「【」→ 真实数据候选（values）
 *   2) B 类缺值（指标名后无数值，光标在指标名末尾/后跟虚词）→ 真实数值候选（values）
 *   3) 指标名前缀 → 字典指标名下（metrics）
 * 优先级：占位符 > B 类缺值 > 指标名前缀。
 */
const { missingValueMarks } = require("./marks");

/* 光标所在段落（空行分界）在光标前的部分。 */
function paragraphPrefix(fullText, head) {
  const before = fullText.slice(0, head);
  if (!before.includes("\n")) return before;
  const lines = before.split("\n");
  let start = 0;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (lines[i].trim() === "") {
      start = lines.slice(0, i + 1).join("\n").length + 1;
      break;
    }
  }
  return fullText.slice(start, head);
}

/* 仅当光标前出现未闭合的「【」（其后暂无「】」）才触发占位符补全。 */
function shouldSuggest(seg) {
  const lastOpen = seg.lastIndexOf("【");
  if (lastOpen < 0) return false;
  return !seg.includes("】", lastOpen);
}

/* 光标左侧连续的词字符（中英文/数字），用于指标名前缀补全。
 * 先跳过尾部空白/标点，再取连续的词字符（如「本月成交 」→「本月成交」）。 */
function currentWordBefore(text) {
  let i = text.length - 1;
  while (i >= 0 && !/[A-Za-z0-9\u4e00-\u9fa5]/.test(text[i])) i--;
  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9\u4e00-\u9fa5]/.test(text[i])) i--;
  return text.slice(i + 1, end);
}

/* 字典中与已输入前缀匹配的指标名（Navicat 列名补全风）。
 * 优先整体前缀；无则取光标前词的最长词尾作前缀（如「本月成交」→「成交」）；
 * 再兜底包含匹配。返回 { tail, matches }：tail 是真正匹配的前缀部分（插入时只替换它），
 * matches 按长度升序、最多 12 个。 */
function metricPrefixCandidates(word, metricNames) {
  const w = word.toLowerCase();
  const prefixMatch = (tail) =>
    metricNames
      .filter((n) => n.toLowerCase().startsWith(tail))
      .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, 12);

  let out = prefixMatch(w);
  if (out.length) return { tail: word, matches: out };

  for (let len = word.length - 1; len >= 1; len--) {
    const tail = word.slice(word.length - len);
    out = prefixMatch(tail);
    if (out.length) return { tail, matches: out };
  }

  const contains = metricNames
    .filter((n) => n.toLowerCase().includes(w))
    .sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, 12);
  return { tail: word, matches: contains };
}

/* 找光标所在的 B 类缺值标记（句子级放宽）：
 * 光标在指标名末尾之后、**同一句内**（指标名到光标之间没有句号/问号/叹号/分号/换行）、
 * 且这段缝隙里**没有数字**，即命中。
 * 这样光标放在「成交率为（提示：…」这段话里的任意位置（补数值之前）都能弹下拉、能 Tab 补全；
 * 一旦句子里补了数值（缝隙里出现数字）就自动压住，不会在已有数值后面乱插。
 * 光标停在指标名**内部**不算（那是打字中，交给前缀下拉）。 */
const B_SENTENCE_STOP_RE = /[\d。！？；\n]/;

function bClassAtHead(marks, head, text) {
  for (const m of marks) {
    const gapLen = head - m.end;
    if (gapLen < 0 || gapLen > 200) continue;
    const gap = text.slice(m.end, head);
    if (B_SENTENCE_STOP_RE.test(gap)) continue;
    return m;
  }
  return null;
}

/* 判定当前光标应弹出什么下拉（纯函数，不触发任何编辑器 API）：
 * 返回 null 或
 *   { kind:"values", mode:"placeholder"|"metric_no_value", pos, res }   ← 真实数据候选
 *   { kind:"metrics", pos, wordFrom, word, metrics }                    ← 指标名下。 */
function computeDropdownInfo(fullText, head, settings, engine) {
  const opts = {
    semantic: settings.semanticEnabled,
    semanticK: settings.semanticK || 3,
    semanticMinScore: settings.semanticMinScore,
    detectMetricWithoutValue: settings.detectMetricWithoutValue,
  };

  /* 1) 占位符【（inlineSuggest 开关） */
  if (settings.inlineSuggest) {
    const lineText = fullText.slice(0, head).split("\n").pop() || "";
    const para = paragraphPrefix(fullText, head);
    const seg = ((fullText.split("\n")[0] || "").slice(0, 120) + "\n\n" + para.replace(/【[^】]*$/, "")).trim();
    if (shouldSuggest(lineText) && seg.length >= 2) {
      const res = engine.suggest(seg, opts);
      if (res) return { kind: "values", mode: "placeholder", pos: head, res };
    }
  }

  /* 2) B 类缺值数值下拉（detectMetricWithoutValue 开关） */
  if (settings.detectMetricWithoutValue) {
    const marks = missingValueMarks(fullText, engine.index.indicatorNames);
    const at = bClassAtHead(marks, head, fullText);
    if (at) {
      const r = engine.analyze(fullText, opts);
      const dr = (r && r.data_requests || []).find(
        (d) =>
          d.request.kind === "metric_no_value" &&
          d.request.metric_pos &&
          d.request.metric_pos[1] === at.end
      );
      if (dr) return { kind: "values", mode: "metric_no_value", pos: head, res: dr.result };
    }
  }

  return null;
}

module.exports = {
  paragraphPrefix,
  shouldSuggest,
  currentWordBefore,
  metricPrefixCandidates,
  bClassAtHead,
  computeDropdownInfo,
};
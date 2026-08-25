/* 上下文波浪线标记（M3 编辑器侧）：
 * 仅扫描当前行，标记引擎分析时使用的上下文元素（门店/日期/指标/占位符）。
 * 统一使用红色波浪线，帮助用户判断引擎是否正确识别了当前行的上下文。
 */

const { detectMissingValue } = require("../engine/detector");

/* 日期模式：2024-07 / 2024年7月 / 7月 / 2024年 */
const DATE_RE = /(20\d{2}[-/年.]\d{1,2}\s*月?)|(20\d{2}\s*年)|(\d{1,2}\s*月)/g;

/* 占位符模式：与 detector.js 中 PLACEHOLDER_RES 对齐 */
const PLACEHOLDER_RE = /【([^】]{1,40})】|\{\{([^{}]{1,40})\}\}|\[([^\]\n]{1,40})\](?!\s*[\(\[])|（([^）]{1,40}待补充[^）]{0,20})）/g;

/* text: 编辑器全文；metricNames: 引擎索引的规范化指标名列表。
 * 返回 [{ start, end, metric, name, matchType }]，start/end 为文档偏移。 */
function missingValueMarks(text, metricNames) {
  const out = [];
  for (const req of detectMissingValue(text, metricNames)) {
    const pos = req.metric_pos;
    if (pos && pos[1] > pos[0]) {
      out.push({
        start: pos[0],
        end: pos[1],
        metric: req.metric_candidate,
        name: req.metric_name,
        matchType: req.metric_match_type,
      });
    }
  }
  return out;
}

/* 扫描单行文本，返回该行内所有上下文标记（维度1/日期/指标/占位符）。
 * 返回 [{ start, end }]，start/end 为行内偏移（调用方需加上行起始偏移得到文档偏移）。
 * 去重：重叠区间只保留更长的标记。 */
function contextMarks(lineText, dim1Values, indicatorNames) {
  const marks = [];

  /* 1) 维度1值（门店/国家/公司等） */
  const sortedDim1 = [...dim1Values].sort((a, b) => b.length - a.length);
  for (const dim1 of sortedDim1) {
    let idx = 0;
    while ((idx = lineText.indexOf(dim1, idx)) >= 0) {
      marks.push({ start: idx, end: idx + dim1.length });
      idx += dim1.length;
    }
  }

  /* 2) 日期 */
  DATE_RE.lastIndex = 0;
  let dm;
  while ((dm = DATE_RE.exec(lineText))) {
    marks.push({ start: dm.index, end: dm.index + dm[0].length });
  }

  /* 3) 指标名 */
  const sortedIndicators = [...indicatorNames].sort((a, b) => b.length - a.length);
  for (const iname of sortedIndicators) {
    let idx = 0;
    while ((idx = lineText.indexOf(iname, idx)) >= 0) {
      const dup = marks.some((m) => m.start === idx && m.end === idx + iname.length);
      if (!dup) {
        marks.push({ start: idx, end: idx + iname.length });
      }
      idx += iname.length;
    }
  }

  /* 4) 占位符 */
  PLACEHOLDER_RE.lastIndex = 0;
  let pm;
  while ((pm = PLACEHOLDER_RE.exec(lineText))) {
    marks.push({ start: pm.index, end: pm.index + pm[0].length });
  }

  /* 去重：按 start 排序，重叠区间保留更长的 */
  marks.sort((a, b) => a.start - b.start || b.end - a.end);
  const deduped = [];
  for (const m of marks) {
    const last = deduped[deduped.length - 1];
    if (last && m.start < last.end) {
      if (m.end - m.start > last.end - last.start) {
        deduped[deduped.length - 1] = m;
      }
    } else {
      deduped.push(m);
    }
  }

  return deduped;
}

module.exports = { missingValueMarks, contextMarks };
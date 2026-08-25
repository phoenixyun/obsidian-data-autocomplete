/* Navicat 式补全下拉的纯判定层自测（v0.1.5）：
 * 1) 占位符「【」→ values 下拉（真实数据候选）
 * 2) B 类缺值（含「成交率为」虚词紧跟）→ values 下拉（数值候选，与波浪线同源）
 * 3) 指标名前缀（含「本月成交」词尾前缀）→ metrics 下拉（字典指标名）
 * 运行：node test/dropdown.test.mjs
 * 说明：computeDropdownInfo 是纯判定，不触发 CodeMirror/Obsidian，可在 node 直测。
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const {
  paragraphPrefix,
  currentWordBefore,
  metricPrefixCandidates,
  bClassAtHead,
  computeDropdownInfo,
} = require("../src/editor/dropdownDecide.js");
const { Engine } = require("../src/engine/engine.js");
const { missingValueMarks } = require("../src/editor/marks.js");

const RECORDS = [
  { store_name: "成都锦华路店", metric_name: "成交率", metric_value: 11.2, data_date: "2026-07", source_file: "门店经营数据-示例.xlsx", source_sheet: "窄表", source_row: 2 },
  { store_name: "成都锦华路店", metric_name: "成交量", metric_value: 315.0, data_date: "2026-07", source_file: "门店经营数据-示例.xlsx", source_sheet: "窄表", source_row: 3 },
  { store_name: "成都锦华路店", metric_name: "客流量", metric_value: 1086.5, data_date: "2026-07", source_file: "门店经营数据-示例.xlsx", source_sheet: "窄表", source_row: 4 },
  { store_name: "成都锦华路店", metric_name: "试驾量", metric_value: 235.3, data_date: "2026-07", source_file: "门店经营数据-示例.xlsx", source_sheet: "窄表", source_row: 5 },
  { store_name: "成都锦华路店", metric_name: "单车毛利", metric_value: 42552.6, data_date: "2026-07", source_file: "门店经营数据-示例.xlsx", source_sheet: "窄表", source_row: 6 },
  { store_name: "成都锦华路店", metric_name: "单车毛利率", metric_value: 14.1, data_date: "2026-07", source_file: "门店经营数据-示例.xlsx", source_sheet: "窄表", source_row: 7 },
];

const engine = new Engine();
engine.rebuild(RECORDS);
const names = engine.index.metricNames;

/* settings 与主流程一致（inlineSuggest / detectMetricWithoutValue 联动） */
const settingsOn = {
  inlineSuggest: true,
  detectMetricWithoutValue: true,
  semanticEnabled: true,
  semanticK: 3,
  semanticMinScore: 0.5,
};

let pass = 0;
let fail = 0;
function check(label, cond, detail) {
  if (cond) {
    pass++;
    console.log("  PASS", label);
  } else {
    fail++;
    console.log("  FAIL", label, detail || "");
  }
}

console.log("指标字典:", names.join(" / "));

/* 1) 段落前缀（空行分界） */
{
  const a = paragraphPrefix("成都锦华路店成交率", 9);
  const b = paragraphPrefix("首行\n\n成都锦华路店成交率", 13);
  const c = paragraphPrefix("a\nb\n成都锦华路店成交率", 13);
  check("单行段落前缀=整段", a === "成都锦华路店成交率", a);
  check("空行后段落只取当前段", b === "成都锦华路店成交率", JSON.stringify(b));
  check("无空行取全文前缀", c === "a\nb\n成都锦华路店成交率", JSON.stringify(c));
}

/* 2) 光标左词 */
{
  check("整串中文词", currentWordBefore("本月成交") === "本月成交", currentWordBefore("本月成交"));
  check("尾部空格先跳过再取词", currentWordBefore("本月成交 ") === "本月成交", currentWordBefore("本月成交 "));
  check("空格后的末词", currentWordBefore("本月成交 试驾") === "试驾", currentWordBefore("本月成交 试驾"));
  check("字母数字词", currentWordBefore("abcDEF") === "abcDEF", currentWordBefore("abcDEF"));
}

/* 3) 指标名前缀候选 */
{
  const c1 = metricPrefixCandidates("成交", names);
  check("成交→指标前缀候选", c1.tail === "成交" && c1.matches.includes("成交率") && c1.matches.includes("成交量") && c1.matches.every((n) => n.startsWith("成交")), JSON.stringify(c1));
  const c2 = metricPrefixCandidates("本月成交", names);
  check("本月成交→词尾前缀 成交", c2.tail === "成交" && c2.matches.includes("成交率"), JSON.stringify(c2));
  const c3 = metricPrefixCandidates("毛利", names);
  check("毛利→长度升序", c3.tail === "毛利" && c3.matches.length === 2 && c3.matches[0] === "单车毛利" && c3.matches[1] === "单车毛利率", JSON.stringify(c3));
  const c4 = metricPrefixCandidates("到店人数", names);
  check("字典外词无候选", c4.matches.length === 0, JSON.stringify(c4));
  const c5 = metricPrefixCandidates("试驾", names);
  check("试驾→试驾量", c5.tail === "试驾" && c5.matches[0] === "试驾量", JSON.stringify(c5));
}

/* 4) B 类缺值标记定位（句子级放宽：指标名后同句内、无数字即命中） */
{
  const marks = missingValueMarks("本月试驾量", names); // [2,5]
  check("紧贴末尾命中", !!bClassAtHead(marks, 5, "本月试驾量"), "null");
  check("虚词'为'后可命中", !!bClassAtHead(marks, 6, "本月试驾量为"), "null");
  check("虚词+空格可命中", !!bClassAtHead(marks, 7, "本月试驾量为 "), "null");
  check("同句内隔着文字（无数字）也可命中", !!bClassAtHead(marks, 8, "本月试驾量abc"), "null");
  check("同句内隔着长文字（如提示语）也可命中", !!bClassAtHead(marks, 14, "本月试驾量abcdefghij"), "null");
  check("数字缝隙不命中", bClassAtHead(marks, 6, "本月试驾量1") === null, "not null");
  check("遇句号后不命中", bClassAtHead(marks, 12, "本月试驾量。后面还有字") === null, "not null");
  check("跨行不命中", bClassAtHead(marks, 7, "本月试驾量\n试驾") === null, "not null");
  check("光标在指标名内部不触发", bClassAtHead(marks, 4, "本月试驾量") === null, "not null");
}

/* 5) 占位符【 → values 下拉 */
{
  const fullText = "成都锦华路店 2026-07\n\n本月成交率为【";
  const head = fullText.length;
  const info = computeDropdownInfo(fullText, head, settingsOn, engine);
  check("占位符→values/placeholder", !!info && info.kind === "values" && info.mode === "placeholder", JSON.stringify(info));
  if (info) {
    check("占位符候选为真实数值 11.2", info.res.state === "EXACT" && info.res.facts[0].metric_value === 11.2, info.res.state + " " + JSON.stringify(info.res.facts));
  }
}

/* 6) B 类缺值 → values 数值下拉（与波浪线同源） */
{
  const fullText = "成都锦华路店 2026-07\n\n成都锦华路店成交率";
  const head = fullText.length;
  const info = computeDropdownInfo(fullText, head, settingsOn, engine);
  check("B类缺值→values/metric_no_value", !!info && info.kind === "values" && info.mode === "metric_no_value", JSON.stringify(info));
  if (info) {
    check("数值候选 EXACT 11.2", info.res.state === "EXACT" && info.res.facts[0].metric_value === 11.2, info.res.state + " " + JSON.stringify(info.res.facts));
  }
}

/* 7) 「成交率为（提示：…」这类带虚词+括号+说明的句子也弹数值下拉 */
{
  const fullText = "成都锦华路店 2026-07\n\n成都锦华路店成交率为（提示：指标名下方会有红色波浪线";
  const head = fullText.length;
  const info = computeDropdownInfo(fullText, head, settingsOn, engine);
  check("虚词+括号+说明后仍弹数值下拉", !!info && info.mode === "metric_no_value", JSON.stringify(info));
  if (info) {
    check("该场景数值候选 EXACT 11.2", info.res.state === "EXACT" && info.res.facts[0].metric_value === 11.2, info.res.state + " " + JSON.stringify(info.res.facts));
  }
}

/* 8) 指标名前缀 → metrics 下拉（Navicat 列名补全风） */
{
  const fullText = "成都锦华路店 2026-07\n\n本月成交";
  const head = fullText.length;
  const info = computeDropdownInfo(fullText, head, settingsOn, engine);
  check("前缀→metrics 下拉", !!info && info.kind === "metrics" && info.metrics.includes("成交率"), JSON.stringify(info));
  if (info) {
    check("只替换词尾前缀（不吞前面文字）", info.wordFrom === head - "成交".length, "wordFrom=" + info.wordFrom + " head=" + head);
  }
}

/* 9) 完整指标名无数值 → B 类优先于前缀 */
{
  const fullText = "成都锦华路店 2026-07\n\n本月成交率";
  const head = fullText.length;
  const info = computeDropdownInfo(fullText, head, settingsOn, engine);
  check("完整指标名缺值→数值下拉而非前缀下拉", !!info && info.mode === "metric_no_value", JSON.stringify(info));
}

/* 10) 开关联动 */
{
  const fullText = "成都锦华路店 2026-07\n\n成都锦华路店成交率";
  const head = fullText.length;
  const off1 = computeDropdownInfo(fullText, head, { ...settingsOn, detectMetricWithoutValue: false }, engine);
  check("关 B 类缺值→无 B 类数值下拉", !(off1 && off1.mode === "metric_no_value"), JSON.stringify(off1));
  const off2 = computeDropdownInfo("成都锦华路店 2026-07\n\n本月成交", 20, { ...settingsOn, inlineSuggest: false }, engine);
  check("关 inlineSuggest→无前缀下拉", !(off2 && off2.kind === "metrics"), JSON.stringify(off2));
  const off3 = computeDropdownInfo(fullText, head, { ...settingsOn, inlineSuggest: false }, engine);
  check("关 inlineSuggest 不影响 B 类数值下拉", !!off3 && off3.mode === "metric_no_value", JSON.stringify(off3));
  const off4 = computeDropdownInfo(fullText, head, { inlineSuggest: false, detectMetricWithoutValue: false }, engine);
  check("双关→无任何下拉", off4 === null, JSON.stringify(off4));
}

console.log("\n结果: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
/* M3 波浪线标记 + Tab 补全链路自测（v0.1.4）：
 * 1) B 类缺值波浪线标记（missingValueMarks 文档偏移）
 * 2) Tab 补全所走的 engine.analyze 链路：metric_no_value 请求 + 真实事实
 * 运行：node test/marks.test.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { missingValueMarks } = require("../src/editor/marks.js");
const { Engine } = require("../src/engine/engine.js");

const RECORDS = [
  { store_name: "成都锦华路店", metric_name: "成交率", metric_value: 11.2, data_date: "2026-07", source_file: "门店经营数据-示例.xlsx", source_sheet: "窄表", source_row: 2 },
  { store_name: "成都锦华路店", metric_name: "客流量", metric_value: 1086.5, data_date: "2026-07", source_file: "门店经营数据-示例.xlsx", source_sheet: "窄表", source_row: 3 },
  { store_name: "成都锦华路店", metric_name: "试驾量", metric_value: 235.3, data_date: "2026-07", source_file: "门店经营数据-示例.xlsx", source_sheet: "窄表", source_row: 4 },
];

const engine = new Engine();
engine.rebuild(RECORDS);
const names = engine.index.metricNames;

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

// 1) 有值 → 无波浪线；缺值 → 波浪线
{
  const a = missingValueMarks("成都锦华路店成交率为11.2", names);
  const b = missingValueMarks("成都锦华路店成交率", names);
  check("带数值不画线", a.length === 0, JSON.stringify(a));
  check("缺值画线且覆盖「成交率」", b.length === 1 && b[0].start === 6 && b[0].end === 9 && b[0].metric === "成交率", JSON.stringify(b));
}
// 2) 别名（试驾量）+「为」尾
{
  const m = missingValueMarks("本月试驾量为", names);
  check("别名缺值画线（试驾量 2..5）", m.length === 1 && m[0].start === 2 && m[0].end === 5 && m[0].metric === "试驾量", JSON.stringify(m));
}
// 3) 字典外指标（到店人数）不属 B 类 → 不画线（走「到店人数为【」语义兜底）
{
  const m = missingValueMarks("本月到店人数为", names);
  check("字典外指标不画线", m.length === 0, JSON.stringify(m));
}
// 4) 多行偏移正确（换行切句）
{
  const m = missingValueMarks("成都锦华路店 试驾量为\n成都锦华路店 成交率为", names);
  check(
    "多行两处波浪线偏移正确",
    m.length === 2 && m[0].start === 7 && m[0].end === 10 && m[1].start === 19 && m[1].end === 22,
    JSON.stringify(m)
  );
}
// 5) Tab 补全的真实链路：engine.analyze 返回 metric_no_value 请求 + EXACT 事实
{
  const text = "成都锦华路店成交率";
  const r = engine.analyze(text, {
    semantic: true,
    semanticK: 3,
    semanticMinScore: 0.5,
    detectMetricWithoutValue: true,
  });
  const dr = (r.data_requests || []).find(
    (d) => d.request.kind === "metric_no_value" && d.request.metric_pos && d.request.metric_pos[1] === 9
  );
  check("analyze 命中 metric_no_value 请求", !!dr, "requests=" + JSON.stringify(r.data_requests));
  if (dr) {
    check("Tab 补全事实为真实数值 11.2", dr.result.state === "EXACT" && dr.result.facts[0].metric_value === 11.2, dr.result.state + " " + JSON.stringify(dr.result.facts));
    check("事实带溯源", dr.result.facts[0].source && dr.result.facts[0].source.file === "门店经营数据-示例.xlsx", JSON.stringify(dr.result.facts[0]));
  }
}
// 6) 关闭 detectMetricWithoutValue → 无 B 类请求（波浪线与 Tab 同时停用）
{
  const r = engine.analyze("成都锦华路店成交率", { semantic: true, detectMetricWithoutValue: false });
  check("关闭缺值检测后无 B 类请求", !(r.data_requests || []).some((d) => d.request.kind === "metric_no_value"), JSON.stringify(r.data_requests));
}

console.log("\n结果: " + pass + " passed, " + fail + " failed");
process.exit(fail ? 1 : 0);
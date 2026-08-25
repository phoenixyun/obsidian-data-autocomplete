/* M1 引擎真实数据自测：直接读 Python 项目的数据文件，验证 JS 解析/索引/检索。
 * 运行：node test/engine.test.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { parseWorkbook, parseCsvText } = require("../src/engine/parser.js");
const { Engine } = require("../src/engine/engine.js");

/* 数据目录：优先用工作区示例数据（vault 根 data-autocomplete-data/），
 * 找不到时退回网页版路径。 */
import { existsSync } from "node:fs";
const VAULT_DATA = "/Users/ze.wang/Downloads/store-autocomplete-vault/data-autocomplete-data";
const DATA = existsSync(VAULT_DATA) ? VAULT_DATA : "/home/ubuntu/store-autocomplete/data/source";
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

const records = [];

// 窄表
{
  const buf = readFileSync(join(DATA, "门店经营数据-示例.xlsx"));
  const recs = parseWorkbook(buf, "门店经营数据-示例.xlsx");
  records.push(...recs);
  console.log("窄表 门店经营数据-示例.xlsx →", recs.length, "条");
}

// 层级宽表（区域经营报表）
{
  const buf = readFileSync(join(DATA, "区域经营报表.xlsx"));
  const recs = parseWorkbook(buf, "区域经营报表.xlsx");
  records.push(...recs);
  console.log("层级宽表 区域经营报表.xlsx →", recs.length, "条");
}

// 单店宽表（10 店示例）
{
  const dir = join(DATA, "门店经营数据-宽表-10店-示例");
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (!/\.xlsx$/i.test(name)) continue;
    const recs = parseWorkbook(readFileSync(join(dir, name)), name);
    records.push(...recs);
    n += recs.length;
  }
  console.log("单店宽表 10店示例 →", n, "条");
}

console.log("总计记录", records.length);
check("解析出至少 5000 条真实记录", records.length >= 5000, "records=" + records.length);

const engine = new Engine();
const stats = engine.rebuild(records);
console.log("索引 stats:", JSON.stringify(stats));
check("索引门店数 ≥ 10", stats.store_count >= 10, "store_count=" + stats.store_count);
check("索引指标数 ≥ 50", stats.metric_count >= 50, "metric_count=" + stats.metric_count);

// 样例报告：成都锦华路店 2026-07（对齐已知真实值：试驾量235.3 成交量35.2 客流量1086.5 客单价301569.4 单车毛利42552.6 成交率11.2）
const sampleReport = `成都锦华路店 2026年7月经营数据

本月试驾量为【待补充】，成交量为【待补充】，客流量是【待补充】。
客单价【待补充】，单车毛利为【待补充】，成交率【待补充】。
总利润【待补充】。`;

const result = engine.analyze(sampleReport, { document_id: "test/成都锦华路店-2026-07.md" });
console.log("context:", JSON.stringify(result.context));
console.log("data_requests:", result.data_requests.length);
check("检测到 7 个数据请求（占位符）", result.data_requests.length === 7, "count=" + result.data_requests.length);

const byMetric = new Map();
for (const dr of result.data_requests) {
  const mn = dr.resolved && dr.resolved.metric_name;
  if (mn) byMetric.set(mn, dr);
}
const expect = {
  试驾量: 235.3,
  成交量: 35.2,
  客流量: 1086.5,
  客单价: 301569.4,
  单车毛利: 42552.6,
  成交率: 11.2,
};
for (const [mn, expected] of Object.entries(expect)) {
  const dr = byMetric.get(mn);
  const got = dr && dr.result && dr.result.facts && dr.result.facts[0] ? dr.result.facts[0].metric_value : null;
  check(
    `指标 ${mn} 命中真实值 ${expected}`,
    got !== null && Math.abs(Number(got) - expected) < 0.01,
    `got=${got}`
  );
}

// NO_RESULT 路径：检索不存在的指标必须返回 NO_RESULT 而非编造
const noval = engine.analyze("成都锦华路店 本月【外星人数量】为");
const novalDr = noval.data_requests.find((d) => (d.request.metric_candidate || "").includes("外星"));
check("不存在指标 → NO_RESULT（绝不编造）", novalDr && novalDr.result.state === "NO_RESULT", JSON.stringify(novalDr && novalDr.result));

// 溯源字段存在
const first = result.data_requests[0].result.facts[0];
check("事实携带溯源 source{file,sheet,row}", !!(first.source && first.source.file && first.source.row), JSON.stringify(first.source));

// 别名：句中出现“试驾数”应命中“试驾量”
const aliasReport = "成都锦华路店 本月试驾数为【待补充】";
const aliasDr = engine.analyze(aliasReport).data_requests[0];
check(
  "别名 试驾数→试驾量 命中",
  aliasDr.resolved.metric_name === "试驾量" && aliasDr.result.facts && aliasDr.result.facts.length > 0,
  JSON.stringify({ resolved: aliasDr.resolved, state: aliasDr.result.state })
);

// 指标缺值（B 类）：句末“成交率为”后无数值
const bReport = "成都锦华路店 2026年7月成交率为";
const bDr = engine.analyze(bReport).data_requests[0];
check("B 类指标缺值被检出且求解", bDr && bDr.request.kind === "metric_no_value" && bDr.result.facts && bDr.result.facts.length > 0, JSON.stringify(bDr && { kind: bDr.request.kind, state: bDr.result.state }));

// M2 语义兜底：结构化未命中的“到店人数”应经语义层找到 进店人数→客流量，事实来自真实记录
const semReport = "成都锦华路店 2026年7月经营数据\n\n本月到店人数为【待补充】。";
const semDr = engine.analyze(semReport).data_requests[0];
check(
  "M2 语义兜底 到店人数→客流量（SEMANTIC_CANDIDATE）",
  semDr &&
    semDr.result.state === "SEMANTIC_CANDIDATE" &&
    semDr.resolved.metric_name === "客流量" &&
    semDr.result.facts &&
    semDr.result.facts[0].metric_name === "客流量" &&
    semDr.result.facts[0].metric_value === 1086.5,
  JSON.stringify(semDr && { state: semDr.result.state, resolved: semDr.resolved, first: semDr.result.facts && semDr.result.facts[0] })
);
const semOffDr = engine.analyze(semReport, { semantic: false }).data_requests[0];
check("关闭语义 → NO_RESULT（不勉强近似）", semOffDr && semOffDr.result.state === "NO_RESULT", JSON.stringify(semOffDr && semOffDr.result));

// 阈值：弱子串重叠不得产生误导性语义候选（外星人数量 仍须 NO_RESULT）
const semNoiseDr = engine.analyze("成都锦华路店 本月【外星人数量】为").data_requests[0];
check("语义阈值过滤噪声（外星人数量 → NO_RESULT）", semNoiseDr && semNoiseDr.result.state === "NO_RESULT", JSON.stringify(semNoiseDr && { state: semNoiseDr.result.state, note: semNoiseDr.result.note }));

// M3 内联补全入口：Engine.suggest 对“光标前句段”返回 top 候选（复用全链路）
const sg1 = engine.suggest("成都锦华路店 2026年7月成交率为");
check(
  "M3 suggest 成交率→11.2",
  sg1 && sg1.facts && sg1.facts[0] && sg1.facts[0].metric_name === "成交率" && Math.abs(Number(sg1.facts[0].metric_value) - 11.2) < 0.01,
  JSON.stringify(sg1 && { state: sg1.state, first: sg1.facts && sg1.facts[0] })
);
const sg2 = engine.suggest("成都锦华路店 2026年7月经营数据\n\n本月到店人数为");
check(
  "M3 suggest 语义兜底 到店人数→客流量 1086.5（标题上下文）",
  sg2 && sg2.state === "SEMANTIC_CANDIDATE" && sg2.facts && sg2.facts[0] && sg2.facts[0].metric_value === 1086.5,
  JSON.stringify(sg2 && { state: sg2.state, first: sg2.facts && sg2.facts[0] })
);
const sg3 = engine.suggest("本月外星人数量为");
check("M3 suggest 不存在指标 → NO_RESULT", sg3 && sg3.state === "NO_RESULT", JSON.stringify(sg3 && { state: sg3.state }));
const sg4 = engine.suggest("本月到店人数为", { semantic: false });
check("M3 suggest 关闭语义 → NO_RESULT", sg4 && sg4.state === "NO_RESULT", JSON.stringify(sg4 && { state: sg4.state }));

// 设置项对应的引擎行为（与网页端 settings.yaml 一一对应）
const bOff = engine.analyze("成都锦华路店 2026年7月成交率为", { detectMetricWithoutValue: false });
check(
  "设置：关闭 B 类缺值检测 → 无 metric_no_value 请求",
  bOff.data_requests.length === 0,
  JSON.stringify(bOff.data_requests.map((d) => d.request.kind))
);
const threshHi = engine.analyze(semReport, { semanticMinScore: 0.99 });
check(
  "设置：语义阈值调高 → 近似不足 → NO_RESULT",
  threshHi.data_requests[0] && threshHi.data_requests[0].result.state === "NO_RESULT",
  JSON.stringify({ state: threshHi.data_requests[0] && threshHi.data_requests[0].result.state, note: threshHi.data_requests[0] && threshHi.data_requests[0].result.note })
);
const threshNote = engine.analyze(semReport, { semanticMinScore: 0.8 });
check(
  "设置：阈值 0.8 的失败说明带有效阈值",
  threshNote.data_requests[0] && /低于阈值 0\.80/.test(threshNote.data_requests[0].result.note),
  JSON.stringify(threshNote.data_requests[0] && threshNote.data_requests[0].result.note)
);
const k1 = engine.analyze(semReport, { semanticK: 1 });
check(
  "设置：semanticK=1 仍命中 客流量 1086.5",
  k1.data_requests[0] && k1.data_requests[0].result.facts && k1.data_requests[0].result.facts[0].metric_value === 1086.5,
  JSON.stringify(k1.data_requests[0] && { facts: k1.data_requests[0].result.facts.map((f) => f.metric_value) })
);

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
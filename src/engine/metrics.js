/* 指标字典与归一化（M1：规则 + 别名表，无 LLM）。
 * 对齐网页版 metric_dict.py：unit / data_type / 后缀白名单 / 前缀防误判 / 库指标合并。 */

const ALIASES = {
  "试驾数": "试驾量", "试驾台次": "试驾量", "试驾量": "试驾量",
  "订单量": "成交量", "订单数": "成交量", "成交量": "成交量",
  "成交数": "成交量", "成交台数": "成交量",
  "进店人数": "客流量", "进店量": "客流量", "客流": "客流量", "客流量": "客流量",
  "客单价": "客单价", "单车客单价": "客单价",
  "毛利": "单车毛利", "毛利额": "单车毛利", "单车毛利": "单车毛利", "单车毛利额": "单车毛利",
  "成交率": "成交率", "转化率": "转化率",
  "销售额": "销售额", "销售收入": "销售额", "营收": "销售额",
  "客户评分": "客户评分", "好评率": "客户评分",
  "总利润": "总利润", "利润": "总利润", "实际利润": "实际利润", "利润目标": "利润目标", "利润达成率": "利润达成率",
  "建议数": "建议数", "建议量": "建议数", "建议条数": "建议数",
  "邀约量": "邀约量", "邀约数": "邀约量",
  "回访量": "回访量", "回访数": "回访量",
  "返厂率": "返厂率", "回厂率": "返厂率",
  "达成率": "达成率", "达成目标": "达成率",
};

/* 指标单位与数据类型（对齐网页版 metric_dict.yaml 的 unit/data_type 字段）。 */
const METRIC_UNITS = {
  "试驾量": "台次", "成交量": "台", "客流量": "人次", "客单价": "元",
  "单车毛利": "元", "成交率": "%", "销售额": "元", "客户评分": "分",
  "总利润": "元", "实际利润": "元", "利润目标": "元", "利润达成率": "%",
  "建议数": "条", "邀约量": "人次", "回访量": "人次", "返厂率": "%", "达成率": "%",
};

const METRIC_DATA_TYPES = {
  "试驾量": "int", "成交量": "int", "客流量": "int", "客单价": "float",
  "单车毛利": "float", "成交率": "float", "销售额": "float", "客户评分": "float",
  "总利润": "float", "实际利润": "float", "利润目标": "float", "利润达成率": "float",
  "建议数": "int", "邀约量": "int", "回访量": "int", "返厂率": "float", "达成率": "float",
};

/* 后缀白名单（对齐网页版 _SUFFIX_MODIFIERS）：指标名后允许出现的量词后缀。
 * 用于“前缀匹配防误判”：如“试驾量率”中“率”不在白名单 → 不当作“试驾量”的变体。 */
const SUFFIX_MODIFIERS = new Set(["人次", "台次", "人数", "数量", "辆", "台", "量", "数", "次", "单", "元", "分", "条", "件", "%"]);

/* 归一化指标名：去空白/全半角/去括号后缀，保留中文主名。 */
function normalizeMetric(name) {
  if (name == null) return "";
  let s = String(name).trim();
  s = s.replace(/[\u3000\s]+/g, "");
  s = s.replace(/[（）()【】\[\]《》]/g, "");
  if (!s) return "";
  return ALIASES[s] || s;
}

function matchMetric(token) {
  /* 返回 { name: 归一化指标名, match_type: exact|alias|partial|null } */
  if (!token) return { name: null, match_type: null };
  const norm = normalizeMetric(token);
  if (!norm) return { name: null, match_type: null };
  const direct = ALIASES[norm];
  if (direct) return { name: direct, match_type: "alias" };
  // 名字本身已在指标集合中时由调用方判 exact；此处只判别名
  return { name: norm, match_type: "unmatched" };
}

/* 从一个指标名集合中做 PARTIAL：包含匹配（双向，长度 ≥2）。 */
function partialMatch(token, metricNames) {
  const norm = normalizeMetric(token);
  if (!norm || norm.length < 2) return null;
  for (const name of metricNames) {
    if (name.length < 2) continue;
    if (name.includes(norm) || norm.includes(name)) return name;
  }
  return null;
}

/* 前缀防误判：token 以某指标名为前缀，但剩余部分是“非白名单后缀”（如“试驾量率”的“率”）→ 不匹配。 */
function prefixMatchSafe(token, metricNames) {
  const norm = normalizeMetric(token);
  if (!norm) return null;
  for (const name of metricNames) {
    if (norm.startsWith(name)) {
      const rest = norm.slice(name.length);
      if (!rest || SUFFIX_MODIFIERS.has(rest)) return name;
      return null; // 剩余部分不在白名单 → 防误判
    }
  }
  return null;
}

/* 库指标合并（对齐网页版 _merge_db_metrics）：把库中真实指标名并入查询字典，
 * 使“库内指标名”也能被精确/前缀命中。返回合并后的指标名集合。 */
function mergeDbMetrics(metricNames, dbMetricNames) {
  const merged = new Set(metricNames);
  for (const n of dbMetricNames || []) merged.add(n);
  return [...merged];
}

/* normalizeIndicator 是 normalizeMetric 的别名，供新引擎使用 */
const normalizeIndicator = normalizeMetric;

module.exports = {
  ALIASES, METRIC_UNITS, METRIC_DATA_TYPES, SUFFIX_MODIFIERS,
  normalizeMetric, normalizeIndicator, matchMetric, partialMatch, prefixMatchSafe, mergeDbMetrics,
};
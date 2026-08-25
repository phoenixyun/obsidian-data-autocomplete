/* 通用指标数据解析（M1）：
 * 新格式（通用指标 CSV）：指标编号,指标名,指标值,指标目标,指标单位,维度1(实体),维度2(时间),指标说明,来源
 * 旧格式兼容：门店窄表 / 层级宽表 / 单店宽表
 * 统一输出字段：indicator_id, indicator_name, indicator_value, indicator_target,
 *                indicator_unit, indicator_desc, dimension_1, dimension_2, source
 */
const XLSX = require("xlsx");

function cell(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (s === "" || s === "-" || s === "—" || s === "/") return null;
  const n = Number(s);
  if (/^-?\d+(\.\d+)?$/.test(s) && Number.isFinite(n)) return n;
  return s;
}

function hdr(row) {
  return (row || []).map((c) => (c == null ? "" : String(c).trim().replace(/[\u3000\s]+/g, "")));
}

/* 识别日期作用域：'2026-07月数据' → {date:'2026-07',role:'月数据'}；'累计值' → {date:'累计',role:'累计值'} */
function dateScope(s) {
  if (s == null) return null;
  const t = String(s).trim();
  const m = t.match(/(\d{4})[-年/](\d{1,2})月?/);
  if (m) {
    const month = String(parseInt(m[2], 10)).padStart(2, "0");
    return { date: m[1] + "-" + month, role: "月数据" };
  }
  if (t.includes("累计")) return { date: "累计", role: "累计值" };
  return null;
}

function isRankScope(s) {
  const t = String(s);
  return /排名|第一|中位数|小组|全国/.test(t) && !/月数据/.test(t);
}

/* ========== 通用指标 CSV 解析（新格式） ========== */
function parseGenericCsv(rows, file) {
  if (rows.length < 2) return null;
  const head = hdr(rows[0]);
  const isGeneric =
    head.some((h) => h.includes("指标编号") || h === "indicator_id") &&
    head.some((h) => h.includes("指标名") || h === "indicator_name");
  if (!isGeneric) return null;

  const ci = {
    id: head.findIndex((h) => h.includes("指标编号") || h === "indicator_id"),
    name: head.findIndex((h) => (h.includes("指标名") && !h.includes("说明")) || h === "indicator_name"),
    value: head.findIndex((h) => h.includes("指标值") || h === "indicator_value"),
    target: head.findIndex((h) => h.includes("指标目标") || h === "indicator_target"),
    unit: head.findIndex((h) => h.includes("指标单位") || h === "indicator_unit"),
    dim1: head.findIndex((h) => h.includes("维度1") || h.includes("实体") || h.includes("国家") || h.includes("公司") || h.includes("门店")),
    dim2: head.findIndex((h) => h.includes("维度2") || h.includes("时间") || h.includes("年份") || h.includes("季度") || h.includes("月份")),
    desc: head.findIndex((h) => h.includes("指标说明") || h === "indicator_desc"),
    source: head.findIndex((h) => h.includes("来源") || h === "source"),
  };
  if (ci.name < 0 || ci.value < 0) return [];

  const recs = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = r[ci.name];
    const val = cell(r[ci.value]);
    if (name == null || String(name).trim() === "" || val == null) continue;
    const indicatorName = String(name).trim();
    recs.push({
      indicator_id: ci.id >= 0 ? String(r[ci.id] || "").trim() || null : null,
      indicator_name: indicatorName,
      indicator_value: val,
      indicator_target: ci.target >= 0 ? cell(r[ci.target]) : null,
      indicator_unit: ci.unit >= 0 ? String(r[ci.unit] || "").trim() || null : null,
      indicator_desc: ci.desc >= 0 ? String(r[ci.desc] || "").trim() || null : null,
      dimension_1: ci.dim1 >= 0 ? String(r[ci.dim1] || "").trim() : "",
      dimension_2: ci.dim2 >= 0 ? String(r[ci.dim2] || "").trim() : "",
      source: ci.source >= 0 ? String(r[ci.source] || "").trim() || null : null,
      source_file: file,
      source_row: i + 1,
    });
  }
  return recs;
}

/* ---------- 标准窄表（旧格式兼容） ---------- */
function parseNarrow(rows, file, sheet) {
  let hi = -1;
  for (let i = 0; i < rows.length && i < 6; i++) {
    const h = hdr(rows[i]);
    if (h.some((x) => x.includes("指标")) && h.some((x) => x.includes("数值"))) { hi = i; break; }
  }
  if (hi < 0) hi = 0;
  const head = hdr(rows[hi]);
  const ci = {
    store: head.findIndex((h) => h.includes("门店") || h.includes("店名")),
    code: head.findIndex((h) => h.includes("编码")),
    month: head.findIndex((h) => h.includes("月份") || h.includes("日期") || h === "时间"),
    metric: head.findIndex((h) => h.includes("指标") && !h.includes("说明")),
    value: head.findIndex((h) => h.includes("数值") || h === "指标值"),
    def: head.findIndex((h) => h.includes("指标说明") || h.includes("说明")),
  };
  if (ci.metric < 0 || ci.value < 0) return [];
  const recs = [];
  for (let i = hi + 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const mName = r[ci.metric];
    const val = cell(r[ci.value]);
    if (mName == null || String(mName).trim() === "" || val == null) continue;
    let date = null;
    if (ci.month >= 0 && r[ci.month] != null) {
      const ds = dateScope(r[ci.month]) || dateScope(String(r[ci.month]) + "月数据");
      date = ds ? ds.date : String(r[ci.month]).trim();
    }
    const indicatorName = String(mName).trim();
    recs.push({
      indicator_id: null,
      indicator_name: indicatorName,
      indicator_value: val,
      indicator_target: null,
      indicator_unit: null,
      indicator_desc: ci.def >= 0 ? String(r[ci.def] || "").trim() || null : null,
      dimension_1: ci.store >= 0 ? String(r[ci.store] || "").trim() : "",
      dimension_2: date || "累计",
      source: null,
      source_file: file,
      source_sheet: sheet,
      source_row: i + 1,
    });
  }
  return recs;
}

/* ---------- 层级/单店宽表（增强：两级表头 + 合并单元格 + date_pattern + module_columns） ---------- */
function parseHierarchical(rows, file, sheet) {
  if (rows.length < 3) return [];
  const h0 = hdr(rows[0]);
  const h1 = hdr(rows[1]);
  const metricCol = h0.findIndex((h) => h.includes("指标") && !h.includes("说明"));
  if (metricCol < 0) return [];
  const defCol = h0.findIndex((h) => h.includes("说明"));
  let storeCol = -1;
  for (let j = 4; j < h0.length; j++) {
    const h = h0[j];
    if (h && !h.includes("指标") && !h.includes("说明") && !h.includes("模块")) { storeCol = j; break; }
  }
  const storeName = storeCol >= 0 ? h0[storeCol] : "";
  const recs = [];
  for (let i = 2; i < rows.length; i++) {
    const r = rows[i] || [];
    const mName = r[metricCol];
    if (mName == null || String(mName).trim() === "") continue;
    const def = defCol >= 0 ? String(r[defCol] || "").trim() || null : null;
    /* 模块上下文（对齐网页版 module_columns）：h0 中“模块”列的值作为指标所属模块。 */
    const moduleCol = h0.findIndex((h) => h.includes("模块"));
    const moduleName = moduleCol >= 0 ? String(r[moduleCol] || "").trim() || null : null;
    const maxJ = Math.min(r.length, h1.length);
    for (let j = 4; j < maxJ; j++) {
      const scope = String(h1[j] || "").trim();
      if (!scope || isRankScope(scope)) continue;
      const ds = dateScope(scope);
      const val = cell(r[j]);
      if (val == null) continue;
      const indicatorName = String(mName).trim();
      recs.push({
        indicator_id: null,
        indicator_name: indicatorName,
        indicator_value: val,
        indicator_target: null,
        indicator_unit: null,
        indicator_desc: def,
        dimension_1: storeName,
        dimension_2: ds ? ds.date : "累计",
        source: null,
        source_file: file,
        source_sheet: sheet,
        source_row: i + 1,
      });
    }
  }
  return recs;
}

/* 合并单元格展开（对齐网页版 merged_cells 处理）：把合并区域的值填充到区域内每个单元格。 */
function expandMerged(ws, rows) {
  if (!ws || !ws["!merges"] || !ws["!merges"].length) return rows;
  const merged = ws["!merges"];
  const grid = rows.map((r) => (r || []).slice());
  for (const m of merged) {
    const { s, e } = m;
    const topVal = grid[s.r] && grid[s.r][s.c] != null ? grid[s.r][s.c] : null;
    if (topVal == null) continue;
    for (let r = s.r; r <= e.r && r < grid.length; r++) {
      if (!grid[r]) grid[r] = [];
      for (let c = s.c; c <= e.c; c++) grid[r][c] = topVal;
    }
  }
  return grid;
}

/* 顶层入口：ArrayBuffer（xlsx/xls）→ 记录数组 */
function parseWorkbook(ab, fileName, sheetName) {
  const wb = XLSX.read(ab, { type: "array" });
  return recordsFromWorkbook(wb, fileName || "数据文件.xlsx", sheetName);
}

/* CSV 文本入口（SheetJS 解析为工作簿）。 */
function parseCsvText(text, fileName) {
  const wb = XLSX.read(text, { type: "string" });
  return recordsFromWorkbook(wb, fileName || "数据文件.csv", undefined);
}

function recordsFromWorkbook(wb, fileName, sheetName) {
  const sheets = sheetName ? [sheetName] : wb.SheetNames;
  const records = [];
  for (const sn of sheets) {
    const ws = wb.Sheets[sn];
    if (!ws || !ws["!ref"]) continue;
    const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    /* 合并单元格展开（对齐网页版 merged_cells 处理） */
    const rows = expandMerged(ws, rawRows);
    // 优先尝试新通用格式
    const generic = parseGenericCsv(rows, fileName);
    if (generic && generic.length) { records.push(...generic); continue; }
    // 回退到旧格式
    const narrow = parseNarrow(rows, fileName, sn);
    if (narrow.length) { records.push(...narrow); continue; }
    records.push(...parseHierarchical(rows, fileName, sn));
  }
  return records;
}

module.exports = { parseWorkbook, parseCsvText, parseGenericCsv, parseNarrow, parseHierarchical, expandMerged, dateScope, isRankScope, cell, hdr };
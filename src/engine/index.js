/* 通用多维指标索引（M1）：
 * 主键：dimension_1 | indicator_name | dimension_2
 * 提供维度值集合、指标名集合、计数。
 * 增量同步：每条记录带 id + content_hash + is_deleted。 */
const { normalizeIndicator } = require("./metrics");

/* 记录内容哈希：用于增量同步判定内容是否变化。 */
function contentHash(rec) {
  const s = [
    rec.indicator_id || "",
    rec.indicator_name || "",
    rec.indicator_value != null ? String(rec.indicator_value) : "",
    rec.indicator_target != null ? String(rec.indicator_target) : "",
    rec.indicator_unit || "",
    rec.indicator_desc || "",
    rec.dimension_1 || "",
    rec.dimension_2 || "",
    rec.source || "",
    rec.source_file || "",
    rec.source_row != null ? String(rec.source_row) : "",
  ].join("|");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/* 记录稳定 id：indicator_name|dimension_1|dimension_2|source_file|source_row */
function recordId(rec) {
  return [
    rec.indicator_name || "",
    rec.dimension_1 || "",
    rec.dimension_2 || "",
    rec.source_file || "",
    rec.source_row != null ? String(rec.source_row) : "",
  ].join("|");
}

function buildIndex(records) {
  const byKey = new Map();       // `${dim1}|${indicator}|${dim2}` -> recs
  const byIndicator = new Map(); // `${indicator}` -> recs（跨维度兜底）
  const dim1Values = new Set();
  const indicatorNames = new Set();
  let total = 0;

  for (const rec of records) {
    const iname = normalizeIndicator(rec.indicator_name);
    if (!iname) continue;
    rec.indicator_name = iname;

    if (!rec.id) rec.id = recordId(rec);
    if (!rec.content_hash) rec.content_hash = contentHash(rec);
    if (rec.is_deleted == null) rec.is_deleted = false;

    const dim1 = rec.dimension_1 || "";
    const dim2 = rec.dimension_2 || "累计";
    if (dim1) dim1Values.add(dim1);
    indicatorNames.add(iname);
    total++;

    const key = dim1 + "|" + iname + "|" + dim2;
    let arr = byKey.get(key);
    if (!arr) { arr = []; byKey.set(key, arr); }
    arr.push(rec);

    let arr2 = byIndicator.get(iname);
    if (!arr2) { arr2 = []; byIndicator.set(iname, arr2); }
    arr2.push(rec);
  }

  return {
    total,
    records,
    byKey,
    byIndicator,
    dim1Values: [...dim1Values],
    indicatorNames: [...indicatorNames],
    stats() {
      return { record_count: total, dim1_count: dim1Values.size, indicator_count: indicatorNames.size };
    },
  };
}

/* 增量同步（对齐网页版 incremental sync） */
function diffRecords(oldRecords, newRecords) {
  const oldMap = new Map();
  for (const rec of oldRecords || []) {
    const id = rec.id || recordId(rec);
    oldMap.set(id, rec);
  }
  const newMap = new Map();
  for (const rec of newRecords || []) {
    const id = rec.id || recordId(rec);
    newMap.set(id, rec);
  }
  const added = [], updated = [], deleted = [], restored = [];
  let skipped = 0;
  for (const [id, rec] of newMap) {
    const old = oldMap.get(id);
    if (!old) { added.push(rec); }
    else if ((old.content_hash || contentHash(old)) !== (rec.content_hash || contentHash(rec))) { updated.push(rec); }
    else { skipped++; }
  }
  for (const [id, old] of oldMap) {
    if (!newMap.has(id)) {
      if (old.is_deleted) { skipped++; }
      else { deleted.push({ ...old, is_deleted: true }); }
    }
  }
  return { added, updated, deleted, restored, skipped };
}

/* 精确查询：dim1 + indicator + dim2 */
function lookup(index, dim1, indicator, dim2) {
  const key = (dim1 || "") + "|" + (indicator || "") + "|" + (dim2 || "");
  return index.byKey.get(key) || [];
}

/* 跨维度兜底查询：仅按指标名 */
function lookupIndicator(index, indicator) {
  return index.byIndicator.get(indicator) || [];
}

module.exports = { buildIndex, lookup, lookupIndicator, diffRecords, contentHash, recordId };
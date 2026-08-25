/* 语义层（M2）：纯本地、确定性、无需模型与网络。
 * 嵌入：字符 + 相邻二元组 哈希落桶(FNV-1a)→256 维单位向量；余弦 = 点积。
 * 索引：指标“表面名”（规范名 + 别名键，别名键→规范名）。
 * 对齐原项目：结构化命中永远优先（AD-21），语义仅在结构化失败后作 SEMANTIC_CANDIDATE 候选；
 * 事实仍来自真实记录索引（lookupIndicator），绝不生成数值。
 * M2b（可选）：bge-zh via transformers.js 的接入点在 semanticTopK 前，替换 embed 实现即可。
 */
const { ALIASES } = require("./metrics");

const DIM = 256;

function featurize(text) {
  const s = String(text || "").replace(/[\u3000\s]+/g, "");
  const feats = [];
  const isToken = (ch) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(ch);
  for (const ch of s) if (isToken(ch)) feats.push(ch);
  for (let i = 0; i < s.length - 1; i++) {
    if (isToken(s[i]) && isToken(s[i + 1])) feats.push(s.slice(i, i + 2));
  }
  return feats;
}

function hashStr(str, dim) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % dim;
}

function embed(text, dim = DIM) {
  const vec = new Float64Array(dim);
  for (const f of featurize(text)) vec[hashStr(f, dim)] += 1;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm || 1);
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // 单位向量 → 余弦 = 点积
}

/* 指标语义索引：{surface, name(规范名), vec}[]。 */
function buildSemanticIndex(metricNames) {
  const surfaces = [];
  const seen = new Set();
  for (const name of metricNames) {
    if (!seen.has(name)) {
      seen.add(name);
      surfaces.push({ surface: name, name });
    }
  }
  for (const key of Object.keys(ALIASES)) {
    if (!seen.has(key)) {
      seen.add(key);
      surfaces.push({ surface: key, name: ALIASES[key] });
    }
  }
  return surfaces.map((e) => Object.assign(e, { vec: embed(e.surface) }));
}

function semanticTopK(query, semIdx, k = 3) {
  if (!semIdx || !semIdx.length) return [];
  const qv = embed(query || "");
  let nz = false;
  for (let i = 0; i < qv.length; i++) if (qv[i] !== 0) { nz = true; break; }
  if (!nz) return [];
  return semIdx
    .map((e) => ({ surface: e.surface, name: e.name, score: cosine(qv, e.vec) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

module.exports = { embed, cosine, featurize, buildSemanticIndex, semanticTopK, DIM };
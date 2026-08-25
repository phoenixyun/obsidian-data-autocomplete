/* Obsidian 插件入口（纯 JS 版，M1）：无外部服务、无 LLM。
 * 数据目录（默认 vault 根下 data-autocomplete-data/）内的 Excel/CSV 由本插件在本地解析并建立内存索引；
 * “分析当前笔记”复用与 Python /analyze-report 同形状的结果并渲染候选卡片（含溯源）。
 */
const { Plugin, Notice, Modal, Setting, MarkdownView, PluginSettingTab } = require("obsidian");
const { Engine } = require("./engine/engine");
const { parseWorkbook, parseCsvText } = require("./engine/parser");
const { inlineSuggestExtension } = require("./editor/inlineSuggest");

const DEFAULT_SETTINGS = {
  dataDir: "data-autocomplete-data",
  autoBuildOnLoad: true,
  semanticEnabled: true,
  semanticK: 3,
  semanticMinScore: 0.5,
  detectMetricWithoutValue: true,
  inlineSuggest: true,
  recordHistory: true,
};

/* 版本号：与 manifest.json 的 version 保持一致；设置页标题会显示它（v0.1.6），
 * 用于在 Obsidian 内确认当前加载的是哪个版本，避免与旧包混淆。 */
const PLUGIN_VERSION = "0.1.6";

class DataAutocompletePlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.engine = new Engine();

    /* 自动创建数据目录（不存在时）；仅新建成功时提示一次。 */
    this.ensureDataDir().then((created) => {
      if (created)
        new Notice(
          `数据目录 ${this.settings.dataDir}/ 不存在，已自动创建；把 Excel/CSV 放进去即可。`
        );
    });

    this.registerEditorExtension(
      inlineSuggestExtension(
        () => this.engine,
        () => this.settings,
        (fact, res) => this.writeHistory("inline", fact, res),
        (fact, res) => this.writeHistory("tab", fact, res)
      )
    );

    this.addSettingTab(new StoreAcJsSettingsTab(this.app, this));

    this.addCommand({
      id: "rebuild-index",
      name: "重建数据索引（解析 vault 内 Excel/CSV）",
      callback: () => this.rebuildIndex(true),
    });

    this.addCommand({
      id: "analyze-current-note",
      name: "分析当前笔记（数据自动补全候选）",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (!checking) this.analyzeCurrentNote(view);
        return true;
      },
    });

    this.addCommand({
      id: "data-overview",
      name: "数据索引概览",
      callback: () => {
        const s = this.engine.stats();
        if (!this.engine.isReady()) {
          new Notice("索引未构建：请先执行“重建数据索引”");
          return;
        }
        new Notice(`索引概览：${s.record_count} 条记录 / ${s.dim1_count} 个维度1 / ${s.indicator_count} 个指标`);
      },
    });

    /* 手动搜索（对齐网页版 SearchService）：查询理解→元数据 narrowing→向量检索→排序。
     * 变体权重：baseline / keyword_boost / vector_pure。 */
    this.addCommand({
      id: "manual-search",
      name: "手动搜索数据（查询理解 + 排序）",
      callback: () => {
        if (!this.engine.isReady()) {
          new Notice("索引未构建：请先执行“重建数据索引”");
          return;
        }
        new SearchModal(this.app, this).open();
      },
    });

    /* 数据预览/明细浏览（对齐网页版 data preview / browse）：
     *  - data-preview：单店单指标全部历史
     *  - browse：全量明细分页
     *  - preview-options：门店+指标筛选项 */
    this.addCommand({
      id: "data-preview",
      name: "数据预览：单店单指标全部历史",
      callback: () => {
        if (!this.engine.isReady()) {
          new Notice("索引未构建：请先执行“重建数据索引”");
          return;
        }
        new DataPreviewModal(this.app, this).open();
      },
    });
    this.addCommand({
      id: "browse-data",
      name: "浏览数据：全量明细分页",
      callback: () => {
        if (!this.engine.isReady()) {
          new Notice("索引未构建：请先执行“重建数据索引”");
          return;
        }
        new BrowseDataModal(this.app, this).open();
      },
    });

    /* 多表管理（对齐网页版多表管理）：子文件夹模拟命名表 + 活跃表切换 + 持久化。
     * 数据目录下每个子文件夹 = 一张命名表；活跃表记录在 settings.activeTable。 */
    this.addCommand({
      id: "manage-tables",
      name: "多表管理：切换活跃数据表",
      callback: () => {
        new TableManagerModal(this.app, this).open();
      },
    });

    /* 备份恢复（对齐网页版 create_backup / restore_latest / ensure_database）：
     *  - create_backup：把数据目录打包为 zip 存到 .obsidian/plugins/.../backups/
     *  - restore_latest：从最新备份恢复数据目录
     *  - ensure_database：确保数据目录存在（幂等） */
    this.addCommand({
      id: "create-backup",
      name: "创建数据备份（打包数据目录）",
      callback: () => this.createBackup(),
    });
    this.addCommand({
      id: "restore-latest-backup",
      name: "恢复最新备份",
      callback: () => this.restoreLatestBackup(),
    });
    this.addCommand({
      id: "ensure-database",
      name: "确保数据目录存在（幂等）",
      callback: async () => {
        const created = await this.ensureDataDir();
        new Notice(created ? "数据目录已创建" : "数据目录已存在");
      },
    });

    /* 一键补全（对齐网页版 fillAll）：扫描全文所有【】占位符，逐个检索并填充。
     * 结果分类：auto（唯一事实自动填充）/ manual（多候选需人工选择）/ nodata（无数据）。 */
    this.addCommand({
      id: "fill-all-placeholders",
      name: "一键补全全部占位符（auto/manual/nodata）",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (!checking) this.fillAllPlaceholders(view);
        return true;
      },
    });

    /* 展开省略号：把「。。。」/「...」转换为【待补充】占位符，便于后续补全。 */
    this.addCommand({
      id: "expand-ellipsis",
      name: "展开省略号为【待补充】占位符",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) return false;
        if (!checking) this.expandEllipsis(view);
        return true;
      },
    });

    if (this.settings.autoBuildOnLoad) {
      this.app.workspace.onLayoutReady(() => this.rebuildIndex(false));
    }
  }

  /* 多表管理：数据目录下每个子文件夹 = 一张命名表。返回 [{ name, fileCount }]。 */
  listTables() {
    const dir = this.settings.dataDir.replace(/^\/+|\/+$/g, "");
    const files = this.app.vault.getFiles().filter((f) => f.path.startsWith(dir + "/"));
    const byDir = new Map();
    for (const f of files) {
      const rel = f.path.slice(dir.length + 1);
      const slash = rel.indexOf("/");
      if (slash < 0) continue; // 数据目录根下的文件不属于任何表
      const name = rel.slice(0, slash);
      byDir.set(name, (byDir.get(name) || 0) + 1);
    }
    return [...byDir.entries()].map(([name, fileCount]) => ({ name, fileCount }));
  }

  /* 备份：把数据目录内所有文件打包为 zip 存到插件目录 backups/（对齐网页版 create_backup）。 */
  async createBackup() {
    const dir = this.settings.dataDir.replace(/^\/+|\/+$/g, "");
    const files = this.app.vault
      .getFiles()
      .filter((f) => f.path === dir || f.path.startsWith(dir + "/"));
    if (!files.length) {
      new Notice("数据目录为空，无需备份");
      return;
    }
    try {
      const { JSZip } = await import("jszip");
      const zip = new JSZip();
      for (const f of files) {
        const rel = f.path.slice(dir.length + 1);
        if (f.extension === "csv") {
          zip.file(rel, await this.app.vault.adapter.read(f.path));
        } else {
          zip.file(rel, await this.app.vault.adapter.readBinary(f.path));
        }
      }
      const buf = await zip.generateAsync({ type: "arraybuffer" });
      const backupDir = this.manifest.dir + "/backups";
      await this.app.vault.adapter.mkdir(backupDir);
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const name = `backup-${ts}.zip`;
      await this.app.vault.adapter.writeBinary(backupDir + "/" + name, buf);
      new Notice(`备份已创建：${name}（${files.length} 个文件）`);
    } catch (e) {
      new Notice("备份失败：" + (e && e.message ? e.message : e));
    }
  }

  /* 恢复：从 backups/ 下最新 zip 恢复数据目录（对齐网页版 restore_latest）。 */
  async restoreLatestBackup() {
    const backupDir = this.manifest.dir + "/backups";
    let names = [];
    try {
      names = await this.app.vault.adapter.list(backupDir);
      names = (names.files || []).filter((n) => /\.zip$/i.test(n));
    } catch (e) {
      names = [];
    }
    if (!names.length) {
      new Notice("没有可用备份");
      return;
    }
    names.sort();
    const latest = names[names.length - 1];
    try {
      const { JSZip } = await import("jszip");
      const buf = await this.app.vault.adapter.readBinary(latest);
      const zip = await JSZip.loadAsync(buf);
      const dir = this.settings.dataDir.replace(/^\/+|\/+$/g, "");
      await this.ensureDataDir();
      const entries = Object.values(zip.files).filter((e) => !e.dir);
      for (const e of entries) {
        const data = await e.async("arraybuffer");
        await this.app.vault.adapter.writeBinary(dir + "/" + e.name, data);
      }
      new Notice(`已从 ${latest.split("/").pop()} 恢复 ${entries.length} 个文件`);
      await this.rebuildIndex(true);
    } catch (e) {
      new Notice("恢复失败：" + (e && e.message ? e.message : e));
    }
  }

  async rebuildIndex(showNotice) {
    const dir = this.settings.dataDir.replace(/^\/+|\/+$/g, "");
    const activeTable = this.settings.activeTable || "";
    const files = this.app.vault
      .getFiles()
      .filter((f) => {
        if (!(f.path === dir || f.path.startsWith(dir + "/"))) return false;
        if (!/\.(xlsx|xls|csv)$/i.test(f.name)) return false;
        /* 活跃表过滤：设置了 activeTable 时，只索引该子文件夹下的文件 */
        if (activeTable) {
          const rel = f.path.slice(dir.length + 1);
          return rel.startsWith(activeTable + "/");
        }
        return true;
      });
    if (!files.length) {
      if (showNotice)
        new Notice(`数据目录 ${dir}/ 下没有 .xlsx/.csv 文件，请放入数据后再重建索引`);
      return;
    }
    const records = [];
    let failed = 0;
    for (const f of files) {
      try {
        if (/\.csv$/i.test(f.name)) {
          const text = await this.app.vault.adapter.read(f.path);
          records.push(...parseCsvText(text, f.name));
        } else {
          const buf = await this.app.vault.adapter.readBinary(f.path);
          records.push(...parseWorkbook(buf, f.name));
        }
      } catch (e) {
        failed++;
        console.error("data-ac parse error:", f.path, e);
      }
    }
    const stats = this.engine.rebuild(records);
    if (showNotice)
      new Notice(
        `索引已重建：${stats.record_count} 条记录 / ${stats.dim1_count} 维度1 / ${stats.indicator_count} 指标（${files.length} 个文件${failed ? `，${failed} 个解析失败` : ""}）`
      );
  }

  async analyzeCurrentNote(view) {
    const file = view.file;
    const text = file ? await this.app.vault.read(file) : view.editor.getValue();
    if (!text) {
      new Notice("当前笔记为空");
      return;
    }
    if (!this.engine.isReady()) {
      new Notice("索引未构建：请先执行“重建数据索引”");
      return;
    }
    const result = this.engine.analyze(text, {
      document_id: file ? file.path : null,
      semantic: this.settings.semanticEnabled,
      semanticK: this.settings.semanticK,
      semanticMinScore: this.settings.semanticMinScore,
      detectMetricWithoutValue: this.settings.detectMetricWithoutValue,
    });
    new AnalyzeResultModal(this.app, result, this).open();
  }

  /* 数据目录存在性保障：不存在则自动创建（返回 true=本次新建）。
   * 导入 / 历史 / 启动时共用。 */
  async ensureDataDir() {
    const dir = this.settings.dataDir.replace(/^\/+|\/+$/g, "");
    if (this.app.vault.getAbstractFileByPath(dir)) return false; // 目录已存在
    try {
      await this.app.vault.adapter.mkdir(dir);
      return true;
    } catch (e) {
      return false;
    }
  }

  /* 补全历史（对应网页版 insertion_history）：JSONL 追加到 数据目录/history.jsonl。
   * 增强（对齐网页版 report_inserter.py）：
   *  - citation_block 固定模板：`{val} {unit}\n（{date}，来源：{file} / {sheet} / Row {row}）`
   *  - 漂移校验（AD-23）：expected 非空时校验 report_text[start:end]==expected，防止占位符已移动。 */
  async writeHistory(kind, fact, result, request, opts = {}) {
    if (!this.settings.recordHistory) return;
    const dir = this.settings.dataDir.replace(/^\/+|\/+$/g, "");
    const entry = {
      ts: new Date().toISOString(),
      kind,
      state: (result && result.state) || null,
      note: (result && result.note) || null,
      indicator_name: fact && fact.indicator_name,
      indicator_value: fact && fact.indicator_value,
      dimension_1: fact && fact.dimension_1,
      dimension_2: fact && fact.dimension_2,
      source_file: fact && fact.source && fact.source.file,
      source_sheet: fact && fact.source && fact.source.sheet,
      source_row: fact && fact.source && fact.source.row,
      request_kind: request && request.kind,
      metric_candidate: request && request.metric_candidate,
      /* 漂移校验结果（AD-23）：expected 非空时校验 report_text[start:end]==expected */
      drift_ok: opts.drift_ok != null ? opts.drift_ok : null,
      drift_expected: opts.drift_expected || null,
      /* citation 模板（对齐网页版 citation_block） */
      citation: opts.citation || null,
    };
    try {
      await this.ensureDataDir();
      await this.app.vault.adapter.append(dir + "/history.jsonl", JSON.stringify(entry) + "\n");
    } catch (e) {
      /* 历史记录失败不影响主流程 */
    }
  }

  /* 生成 citation 文本（对齐网页版 citation_block 固定模板）。 */
  citationBlock(fact, unit) {
    if (!fact) return "";
    const val = fact.indicator_value != null ? fact.indicator_value : "";
    const u = unit || "";
    const date = fact.dimension_2 || "";
    const file = (fact.source && fact.source.file) || "";
    const sheet = (fact.source && fact.source.sheet) || "";
    const row = fact.source && fact.source.row != null ? fact.source.row : "";
    return `${val} ${u}\n（${date}，来源：${file}${sheet ? " / " + sheet : ""} / Row ${row}）`;
  }

  /* 漂移校验（AD-23）：expected 非空时校验 report_text[start:end]==expected。
   * 返回 { ok, actual }；ok=false 表示占位符已移动，不应盲目替换。 */
  checkDrift(reportText, start, end, expected) {
    if (expected == null) return { ok: true, actual: null };
    const actual = reportText.slice(start, end);
    return { ok: actual === expected, actual };
  }

  /* 产品指标打点（对齐网页版 report_analysis / user_action JSONL）：
   * 追加到 数据目录/events.jsonl，记录分析/搜索/插入等用户行为。 */
  async trackEvent(kind, payload = {}) {
    if (!this.settings.recordHistory) return;
    const dir = this.settings.dataDir.replace(/^\/+|\/+$/g, "");
    const entry = {
      ts: new Date().toISOString(),
      kind,
      ...payload,
    };
    try {
      await this.ensureDataDir();
      await this.app.vault.adapter.append(dir + "/events.jsonl", JSON.stringify(entry) + "\n");
    } catch (e) {
      /* 打点失败不影响主流程 */
    }
  }

  /* 一键补全全部占位符（对齐网页版 fillAll）：
   * 扫描全文所有【…】占位符，逐个走完整检索链（结构化→语义→NO_RESULT）。
   * 结果分类：auto（唯一事实自动填充）/ manual（多候选需人工选择）/ nodata（无数据）。
   * 只替换真实数据；检索不到保持占位符不动，绝不编造。 */
  async fillAllPlaceholders(view) {
    if (!this.engine.isReady()) {
      new Notice("索引未构建：请先执行“重建数据索引”");
      return;
    }
    const editor = view.editor;
    const text = editor.getValue();
    const re = /【([^】\n]{1,40})】/g;
    const matches = [];
    let m;
    while ((m = re.exec(text))) matches.push({ from: m.index, to: m.index + m[0].length, label: m[1] });
    if (!matches.length) {
      new Notice("当前笔记没有【】占位符");
      return;
    }
    const stats = { auto: 0, manual: 0, nodata: 0 };
    const edits = [];
    for (const ph of matches) {
      const r = this.engine.analyze(text, {
        semantic: this.settings.semanticEnabled,
        semanticK: this.settings.semanticK,
        semanticMinScore: this.settings.semanticMinScore,
        detectMetricWithoutValue: this.settings.detectMetricWithoutValue,
      });
      const dr = (r.data_requests || []).find(
        (d) => d.request.kind === "placeholder" && d.request.placeholder_pos && d.request.placeholder_pos[0] === ph.from
      );
      const facts = (dr && dr.result && dr.result.facts) || [];
      if (!facts.length) {
        stats.nodata++;
        continue;
      }
      if (facts.length === 1) {
        edits.push({ from: ph.from, to: ph.to, insert: String(facts[0].indicator_value) });
        stats.auto++;
      } else {
        stats.manual++;
      }
    }
    if (edits.length) {
      /* 优先用 CodeMirror 事务批量替换（一次 dispatch 完成全部占位符） */
      const cm = editor.cm;
      if (cm) {
        cm.dispatch({ changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })) });
      } else {
        /* 兜底：从后往前逐个替换，避免偏移错位 */
        for (let i = edits.length - 1; i >= 0; i--) {
          const e = edits[i];
          editor.replaceRange(e.insert, e.from, e.to);
        }
      }
    }
    new Notice(`一键补全完成：auto ${stats.auto} / manual ${stats.manual} / nodata ${stats.nodata}`);
    this.trackEvent("fill_all", { auto: stats.auto, manual: stats.manual, nodata: stats.nodata });
  }

  /* 展开省略号：把「。。。」/「...」/「……」（行内连续 3 个及以上）替换为【待补充】占位符。 */
  expandEllipsis(view) {
    const editor = view.editor;
    const text = editor.getValue();
    const re = /(?:。{3,}|\.{3,}|…{2,})/g;
    const edits = [];
    let m;
    while ((m = re.exec(text))) edits.push({ from: m.index, to: m.index + m[0].length, insert: "【待补充】" });
    if (!edits.length) {
      new Notice("没有可展开的省略号");
      return;
    }
    const cm = editor.cm;
    if (cm) {
      cm.dispatch({ changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })) });
    } else {
      /* 兜底：从后往前逐个替换，避免偏移错位 */
      for (let i = edits.length - 1; i >= 0; i--) {
        const e = edits[i];
        editor.replaceRange(e.insert, e.from, e.to);
      }
    }
    new Notice(`已展开 ${edits.length} 处省略号为【待补充】`);
  }

  }

/* ---------- 手动搜索弹窗（对齐网页版 SearchService） ---------- */
class SearchModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.variant = "baseline"; // baseline / keyword_boost / vector_pure
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("store-ac-modal");

    const header = contentEl.createEl("div", { cls: "store-ac-header" });
    header.createEl("h3", { text: "手动搜索数据" });

    const input = contentEl.createEl("input", {
      cls: "store-ac-search-input",
      type: "text",
      placeholder: "输入查询，如：成都锦华路店 3月 客流量",
    });
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") this.runSearch(input.value);
    });

    const variantRow = contentEl.createEl("div", { cls: "store-ac-dims" });
    const variants = [
      ["baseline", "baseline"],
      ["keyword_boost", "keyword_boost"],
      ["vector_pure", "vector_pure"],
    ];
    variants.forEach(([id, label]) => {
      const btn = variantRow.createEl("button", {
        cls: "store-ac-variant" + (this.variant === id ? " is-active" : ""),
        text: label,
      });
      btn.addEventListener("click", () => {
        this.variant = id;
        variantRow.querySelectorAll(".store-ac-variant").forEach((b) => b.removeClass("is-active"));
        btn.addClass("is-active");
        if (input.value.trim()) this.runSearch(input.value);
      });
    });

    this.resultsEl = contentEl.createEl("div", { cls: "store-ac-facts" });
    input.focus();
  }

  runSearch(query) {
    const q = (query || "").trim();
    if (!q) return;
    const engine = this.plugin.engine;
    const res = engine.search(q, { variant: this.variant });
    this.resultsEl.empty();
    if (!res || !res.results || !res.results.length) {
      this.resultsEl.createEl("div", { cls: "store-ac-noresult", text: "未检索到匹配记录（不编造数值）。" });
      return;
    }
    const meta = this.resultsEl.createEl("div", { cls: "store-ac-dims", text: `查询理解：${res.understood || ""} · 变体 ${this.variant} · ${res.results.length} 条` });
    res.results.forEach((r) => {
      const row = this.resultsEl.createEl("div", { cls: "store-ac-fact" });
      row.createEl("span", {
        cls: "store-ac-value",
        text: String(r.indicator_value),
      });
      row.createEl("span", {
        cls: "store-ac-factmeta",
        text: `${r.dimension_1 || "（无维度1）"} · ${r.dimension_2} · ${r.indicator_name}`,
      });
      row.createEl("span", {
        cls: "store-ac-source",
        text: `${r.source_file}${r.source_sheet ? "/" + r.source_sheet : ""} R${r.source_row}`,
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ---------- 数据预览弹窗（对齐网页版 data preview：单店单指标全部历史） ---------- */
class DataPreviewModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.page = 0;
    this.pageSize = 50;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("store-ac-modal");

    const header = contentEl.createEl("div", { cls: "store-ac-header" });
    header.createEl("h3", { text: "数据预览：单店单指标全部历史" });

    const engine = this.plugin.engine;
    const dim1Values = engine.index.dim1Values;
    const indicators = engine.index.indicatorNames;

    const row1 = contentEl.createEl("div", { cls: "store-ac-dims" });
    const dim1Sel = row1.createEl("select", { cls: "store-ac-select" });
    dim1Values.forEach((s) => dim1Sel.createEl("option", { text: s, value: s }));
    const indicatorSel = row1.createEl("select", { cls: "store-ac-select" });
    indicators.forEach((m) => indicatorSel.createEl("option", { text: m, value: m }));

    const btn = row1.createEl("button", { cls: "store-ac-copy", text: "查询" });
    this.resultsEl = contentEl.createEl("div", { cls: "store-ac-facts" });

    const run = () => {
      const dim1 = dim1Sel.value;
      const indicator = indicatorSel.value;
      const recs = engine.index.records.filter(
        (r) => r.dimension_1 === dim1 && r.indicator_name === indicator
      );
      recs.sort((a, b) => (a.dimension_2 < b.dimension_2 ? -1 : a.dimension_2 > b.dimension_2 ? 1 : 0));
      this.render(recs);
    };
    btn.addEventListener("click", run);
    dim1Sel.addEventListener("change", run);
    indicatorSel.addEventListener("change", run);
    run();
  }

  render(recs) {
    this.resultsEl.empty();
    if (!recs.length) {
      this.resultsEl.createEl("div", { cls: "store-ac-noresult", text: "无记录" });
      return;
    }
    const total = recs.length;
    const pages = Math.ceil(total / this.pageSize);
    if (this.page >= pages) this.page = pages - 1;
    const slice = recs.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize);
    const meta = this.resultsEl.createEl("div", {
      cls: "store-ac-dims",
      text: `共 ${total} 条 · 第 ${this.page + 1}/${pages} 页`,
    });
    slice.forEach((r) => {
      const row = this.resultsEl.createEl("div", { cls: "store-ac-fact" });
      row.createEl("span", { cls: "store-ac-value", text: String(r.indicator_value) });
      row.createEl("span", {
        cls: "store-ac-factmeta",
        text: `${r.dimension_1} · ${r.dimension_2} · ${r.indicator_name}`,
      });
      row.createEl("span", {
        cls: "store-ac-source",
        text: `${r.source_file}${r.source_sheet ? "/" + r.source_sheet : ""} R${r.source_row}`,
      });
    });
    if (pages > 1) {
      const nav = this.resultsEl.createEl("div", { cls: "store-ac-dims" });
      const prev = nav.createEl("button", { cls: "store-ac-copy", text: "上一页" });
      prev.addEventListener("click", () => {
        if (this.page > 0) { this.page--; this.render(recs); }
      });
      const next = nav.createEl("button", { cls: "store-ac-copy", text: "下一页" });
      next.addEventListener("click", () => {
        if (this.page < pages - 1) { this.page++; this.render(recs); }
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ---------- 明细浏览弹窗（对齐网页版 browse：全量明细分页） ---------- */
class BrowseDataModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.page = 0;
    this.pageSize = 100;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("store-ac-modal");

    const header = contentEl.createEl("div", { cls: "store-ac-header" });
    header.createEl("h3", { text: "数据明细浏览（全量分页）" });

    const engine = this.plugin.engine;
    const all = engine.index.records;
    this.resultsEl = contentEl.createEl("div", { cls: "store-ac-facts" });
    this.render(all);
  }

  render(recs) {
    this.resultsEl.empty();
    const total = recs.length;
    const pages = Math.ceil(total / this.pageSize);
    if (this.page >= pages) this.page = pages - 1;
    const slice = recs.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize);
    const meta = this.resultsEl.createEl("div", {
      cls: "store-ac-dims",
      text: `共 ${total} 条 · 第 ${this.page + 1}/${pages} 页`,
    });
    slice.forEach((r) => {
      const row = this.resultsEl.createEl("div", { cls: "store-ac-fact" });
      row.createEl("span", { cls: "store-ac-value", text: String(r.indicator_value) });
      row.createEl("span", {
        cls: "store-ac-factmeta",
        text: `${r.dimension_1 || "（无维度1）"} · ${r.dimension_2} · ${r.indicator_name}`,
      });
      row.createEl("span", {
        cls: "store-ac-source",
        text: `${r.source_file}${r.source_sheet ? "/" + r.source_sheet : ""} R${r.source_row}`,
      });
    });
    if (pages > 1) {
      const nav = this.resultsEl.createEl("div", { cls: "store-ac-dims" });
      const prev = nav.createEl("button", { cls: "store-ac-copy", text: "上一页" });
      prev.addEventListener("click", () => {
        if (this.page > 0) { this.page--; this.render(recs); }
      });
      const next = nav.createEl("button", { cls: "store-ac-copy", text: "下一页" });
      next.addEventListener("click", () => {
        if (this.page < pages - 1) { this.page++; this.render(recs); }
      });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ---------- 多表管理弹窗（对齐网页版多表管理：子文件夹=命名表，切换活跃表） ---------- */
class TableManagerModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("store-ac-modal");

    const header = contentEl.createEl("div", { cls: "store-ac-header" });
    header.createEl("h3", { text: "多表管理" });

    const dir = this.plugin.settings.dataDir.replace(/^\/+|\/+$/g, "");
    const tables = this.plugin.listTables();
    const active = this.plugin.settings.activeTable || "";

    const listEl = contentEl.createEl("div", { cls: "store-ac-facts" });
    if (!tables.length) {
      listEl.createEl("div", {
        cls: "store-ac-noresult",
        text: `数据目录 ${dir}/ 下没有子文件夹表。可在数据目录下创建子文件夹，每个子文件夹 = 一张命名表。`,
      });
    }
    tables.forEach((t) => {
      const row = listEl.createEl("div", { cls: "store-ac-fact" });
      row.createEl("span", {
        cls: "store-ac-value",
        text: t.name + (t.name === active ? "（活跃）" : ""),
      });
      row.createEl("span", {
        cls: "store-ac-factmeta",
        text: `${t.fileCount} 个文件`,
      });
      const btn = row.createEl("button", {
        cls: "store-ac-copy",
        text: t.name === active ? "已激活" : "设为活跃",
      });
      btn.addEventListener("click", async () => {
        this.plugin.settings.activeTable = t.name;
        await this.plugin.saveData(this.plugin.settings);
        new Notice(`活跃表已切换为：${t.name}`);
        this.onOpen();
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ---------- 结果弹窗（渲染 data_requests 卡片，与 v0.2 sidecar 版同风格） ---------- */
class AnalyzeResultModal extends Modal {
  constructor(app, result, plugin) {
    super(app);
    this.result = result;
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("store-ac-modal");

    const header = contentEl.createEl("div", { cls: "store-ac-header" });
    header.createEl("h3", { text: "数据自动补全候选" });
    const ctx = this.result.context || {};
    const ctxText =
      `上下文：${ctx.dim1 ? "维度1 " + ctx.dim1 + "（" + (ctx.dim1_scope || "文档") + "）" : "维度1未识别"}` +
      `，${ctx.data_date ? "日期 " + ctx.data_date : "日期未识别"}` +
      (ctx.missing && ctx.missing.length ? `，缺失：${ctx.missing.join("/")}` : "");
    header.createEl("div", { cls: "store-ac-context", text: ctxText });
    header.createEl("div", {
      cls: "store-ac-meta",
      text: `耗时 ${this.result.analysis_time_ms} ms · ${this.result.data_requests.length} 个数据请求`,
    });

    if (!this.result.data_requests.length) {
      contentEl.createEl("div", {
        cls: "store-ac-empty",
        text: "未检测到数据请求（占位符/指标缺值）。NO_RESULT 是正常路径：只检索真实数据，绝不编造。",
      });
    }

    this.result.data_requests.forEach((dr) => {
      const req = dr.request || {};
      const res = dr.resolved || {};
      const resu = dr.result || {};
      const card = contentEl.createEl("div", { cls: "store-ac-card" });

      const row1 = card.createEl("div", { cls: "store-ac-row" });
      row1.createEl("span", { cls: "store-ac-kind", text: req.kind || "?" });
      row1.createEl("span", {
        cls: "store-ac-conf conf-" + (req.confidence_label || "").toLowerCase(),
        text: (req.confidence_label || "") + " " + (req.confidence != null ? req.confidence : ""),
      });
      row1.createEl("span", {
        cls: "store-ac-metric",
        text: req.metric_candidate ? "指标：" + req.metric_candidate : "（无指标词）",
      });
      if (req.placeholder)
        row1.createEl("span", { cls: "store-ac-placeholder", text: "占位符 " + req.placeholder });

      if (req.sentence) card.createEl("div", { cls: "store-ac-sentence", text: req.sentence });

      const dims = card.createEl("div", { cls: "store-ac-dims" });
      const dimBits = [];
      if (res.metric_name) dimBits.push(`指标 ${res.metric_name}（${res.metric_match_type || req.metric_match_type || "?"}）`);
      if (res.dim1) dimBits.push(`维度1 ${res.dim1}（${res.dim1_scope || "?"}）`);
      if (res.data_date) dimBits.push(`维度2 ${res.data_date}（${res.date_scope || "?"}）`);
      if (res.missing && res.missing.length) dimBits.push(`缺失：${res.missing.join("/")}`);
      dims.setText(dimBits.join(" · ") || "维度未解析");

      const stateCls =
        resu.state === "NO_RESULT" ? "store-ac-state-none" : resu.state === "SEMANTIC_CANDIDATE" ? "store-ac-state-sem" : "store-ac-state-ok";
      const stateDiv = card.createEl("div", {
        cls: stateCls,
        text: `状态：${resu.state || "?"}`,
      });
      if (resu.note) stateDiv.createEl("span", { cls: "store-ac-note", text: `（${resu.note}）` });

      const factsWrap = card.createEl("div", { cls: "store-ac-facts" });
      if (resu.facts && resu.facts.length) {
        resu.facts.forEach((f) => {
          const frow = factsWrap.createEl("div", { cls: "store-ac-fact" });
          const val = frow.createEl("span", {
            cls: "store-ac-value",
            text: String(f.indicator_value),
          });
          val.setAttr(
            "title",
            (f.indicator_desc || "") + "\n来源：" + f.source.file + (f.source.sheet ? " / " + f.source.sheet : "") + " 第 " + f.source.row + " 行"
          );
          frow.createEl("span", {
            cls: "store-ac-factmeta",
            text: `${f.dimension_1 || "（无维度1）"} · ${f.dimension_2} · ${f.match_type}`,
          });
          frow.createEl("span", {
            cls: "store-ac-source",
            text: `${f.source.file}${f.source.sheet ? "/" + f.source.sheet : ""} R${f.source.row}`,
          });
        });
      } else {
        factsWrap.createEl("div", { cls: "store-ac-noresult", text: "NO_RESULT：未检索到真实记录，不编造数值。" });
      }

      const copyBtn = card.createEl("button", { cls: "store-ac-copy", text: "复制候选文本" });
      copyBtn.addEventListener("click", () => {
        /* 对齐网页版 citation_block 固定模板：`{val} {unit}\n（{date}，来源：{file} / {sheet} / Row {row}）` */
        const lines = (resu.facts || []).map((f) => {
          const unit = (f.indicator_unit || "").trim();
          const val = f.indicator_value != null ? f.indicator_value : "";
          const date = f.dimension_2 || "";
          const file = (f.source && f.source.file) || "";
          const sheet = (f.source && f.source.sheet) || "";
          const row = f.source && f.source.row != null ? f.source.row : "";
          return `${val} ${unit}\n（${date}，来源：${file}${sheet ? " / " + sheet : ""} / Row ${row}）`;
        });
        const txt = lines.length
          ? lines.join("\n")
          : `【${req.metric_candidate || req.placeholder || "待补充"}】未检索到真实数据`;
        navigator.clipboard.writeText(txt);
        if (this.plugin) {
          const fact = (resu.facts || [])[0] || null;
          this.plugin.writeHistory("copy", fact, resu, req, {
            citation: this.plugin.citationBlock(fact, fact && fact.indicator_unit),
          });
        }
      });
    });

    const footer = contentEl.createEl("div", { cls: "store-ac-footer" });
    footer.createEl("span", { text: "已强制数据溯源 · 无 LLM" });
  }

  onClose() {
    this.contentEl.empty();
  }
}

/* ---------- 设置页 ---------- */
class StoreAcJsSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", {
      text: "数据自动补全（纯本地 · 无 LLM） · v" + PLUGIN_VERSION,
    });

    containerEl.createEl("h3", { text: "数据源与基础操作" });

    new Setting(containerEl)
      .setName("数据目录")
      .setDesc("vault 内存放 Excel/CSV 的目录（相对 vault 根）。支持窄表与层级宽表。")
      .addText((t) =>
        t
          .setValue(this.plugin.settings.dataDir)
          .onChange(async (v) => {
            this.plugin.settings.dataDir = v.trim() || "data-autocomplete-data";
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("启动时自动重建索引")
      .setDesc("打开 vault 时自动解析数据目录并建立内存索引。")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.autoBuildOnLoad)
          .onChange(async (v) => {
            this.plugin.settings.autoBuildOnLoad = v;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("立即重建索引")
      .setDesc("数据文件更新后点此重建；也可用命令面板执行“重建数据索引”。")
      .addButton((b) =>
        b.setButtonText("重建索引").onClick(() => this.plugin.rebuildIndex(true))
      );

    containerEl.createEl("h3", { text: "检索与语义" });

    new Setting(containerEl)
      .setName("语义兜底（近似匹配·纯本地）")
      .setDesc("结构化检索未命中时，用本地哈希向量近似找到最像的指标再查真实数据；关闭后严格只做结构化匹配。")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.semanticEnabled)
          .onChange(async (v) => {
            this.plugin.settings.semanticEnabled = v;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("语义候选个数")
      .setDesc("语义兜底最多展示几个候选指标（对应网页端检索 top_k，默认 3）。")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.semanticK || 3))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n >= 1 && n <= 10) {
              this.plugin.settings.semanticK = n;
              await this.plugin.saveData(this.plugin.settings);
            }
          })
      );

    new Setting(containerEl)
      .setName("语义命中阈值")
      .setDesc("低于该相似度的“近似指标”不计入候选（对应网页端 score_threshold；默认 0.5 挡噪声）。")
      .addSlider((sl) =>
        sl
          .setLimits(0, 1, 0.05)
          .setValue(this.plugin.settings.semanticMinScore)
          .onChange(async (v) => {
            this.plugin.settings.semanticMinScore = v;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    containerEl.createEl("h3", { text: "编辑器补全与检测" });

    new Setting(containerEl)
      .setName("编辑器内联补全（占位符 + 指标名下拉）")
      .setDesc("输入占位符「【」时就地展示真实数据候选下拉（↑↓ 选择、回车/点击插入数值并自动补上「】」）；输入字典指标名的前缀时（如「成交」）弹出指标名下拉（↑↓ 选择、回车补全指标名）。")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.inlineSuggest)
          .onChange(async (v) => {
            this.plugin.settings.inlineSuggest = v;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("B 类缺值检测（波浪线 + Tab/下拉补全）")
      .setDesc("指标名后 12 字符内无数值时也生成候选（对应网页端 detect_metric_without_value）：输入「成都锦华路店成交率」这类句子时，指标名下方画红色波浪线，光标停在指标名末尾会弹出真实数值候选下拉（↑↓ 选择、回车/点击插入），按 Tab 直接补首个候选；关闭后波浪线、下拉与 Tab 补全同时停用。")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.detectMetricWithoutValue)
          .onChange(async (v) => {
            this.plugin.settings.detectMetricWithoutValue = v;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName("记录补全历史")
      .setDesc("每次弹窗复制/内联插入追加一行到 数据目录/history.jsonl（对应网页端 insertion_history）。")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.recordHistory)
          .onChange(async (v) => {
            this.plugin.settings.recordHistory = v;
            await this.plugin.saveData(this.plugin.settings);
          })
      );

    containerEl.createEl("p", {
      cls: "store-ac-hint",
      text: "纯本地运行：无外部服务、无 LLM。只检索真实数据，检索不到显示 NO_RESULT，绝不编造数值。",
    });
  }
}

module.exports = DataAutocompletePlugin;
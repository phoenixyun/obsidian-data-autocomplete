/* M3 编辑器内联补全（CodeMirror 6，Navicat 式下拉）：
 * 1) 占位符「【」：光标处弹出真实数据候选下拉，↑↓/回车/点击插入数值并自动补上「】」。
 * 2) B 类缺值（指标名后无数值）：指标名下方画红色波浪线，光标停在指标名末尾时弹出
 *    真实数值候选下拉（多条可选中）；Tab 直接补首个候选。
 * 3) 指标名前缀（Navicat 列名补全风）：输入字典指标名的前缀时弹出指标名下拉，选中即补全。
 * 全部复用引擎完整链路（结构化→语义兜底→NO_RESULT），零后端、零 LLM：
 * 只展示真实记录，检索不到显示 NO_RESULT，绝不编造。
 */
const { StateField, StateEffect, Prec, RangeSetBuilder } = require("@codemirror/state");
const { showTooltip, keymap, ViewPlugin, Decoration } = require("@codemirror/view");
const { Notice } = require("obsidian");
const { missingValueMarks, contextMarks } = require("./marks");

const hideInlineTooltip = StateEffect.define();

/* 每个编辑器视图一个会话：tooltip 当前内容 + 活动序号 + 候选 DOM 句柄 */
const sessions = new WeakMap();
function getSession(view) {
  let s = sessions.get(view);
  if (!s) {
    s = { tooltip: null, active: 0, items: [], justInserted: false };
    sessions.set(view, s);
  }
  return s;
}

const { computeDropdownInfo, bClassAtHead } = require("./dropdownDecide");

function tooltipSpec(info) {
  /* info = { kind:"values", pos, res } 或 { kind:"metrics", pos, wordFrom, metrics } */
  const pos = info.pos;
  return {
    pos,
    above: true,
    class: "store-ac-tip",
    create(view) {
      const session = getSession(view);
      session.tooltip = info;
      session.onInsert = info.onInsert || null;
      session.active = 0;
      session.justInserted = false;

      const dom = document.createElement("div");
      dom.className = "store-ac-inline";

      /* 玻璃态滑动高亮滑块：独立背景层，在选项间平滑滑动（macOS 设置列表风） */
      const slider = document.createElement("div");
      slider.className = "store-ac-inline-slider";
      dom.appendChild(slider);
      session.slider = slider;

      /* 指标名前缀下拉（Navicat 列名补全风） */
      if (info.kind === "metrics") {
        const title = document.createElement("div");
        title.className = "store-ac-inline-title is-metric";
        title.textContent =
          "指标候选（字典 " + info.metrics.length + " 个）· ↑↓ 选择，回车/点击补全指标名";
        dom.appendChild(title);
        session.items = info.metrics.map((m, i) => {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "store-ac-inline-item" + (i === 0 ? " is-active" : "");
          btn.textContent = m;
          btn.addEventListener("click", () => insertMetricName(view, info.wordFrom, m));
          dom.appendChild(btn);
          return { el: btn, insert: () => insertMetricName(view, info.wordFrom, m) };
        });
        moveSlider(session);
        return { dom };
      }

      /* kind === "values"：真实数据候选（占位符 / B 类缺值共用） */
      const facts = (info.res.facts || []).slice(0, 4);
      const title = document.createElement("div");
      title.className =
        "store-ac-inline-title " +
        (info.res.state === "NO_RESULT" ? "is-none" : info.res.state === "SEMANTIC_CANDIDATE" ? "is-sem" : "is-ok");
      title.textContent = info.res.state + (info.res.note ? " · " + info.res.note : "");
      dom.appendChild(title);

      if (!facts.length) {
        const none = document.createElement("div");
        none.className = "store-ac-inline-none";
        none.textContent = "NO_RESULT：真实数据里没有对应记录，不编造数值。";
        dom.appendChild(none);
        session.items = [];
        return { dom };
      }

      session.items = facts.map((fact, i) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "store-ac-inline-item" + (i === 0 ? " is-active" : "");
        btn.textContent =
          fact.indicator_value +
          "  " +
          (fact.indicator_name || "") +
          "@" +
          (fact.dimension_2 || "累计") +
          "  " +
          (fact.dimension_1 || "") +
          "  (" +
          (fact.source.file || "") +
          ":" +
          (fact.source.row != null ? fact.source.row : "") +
          ")";
        btn.addEventListener("click", () => insertFact(view, fact));
        dom.appendChild(btn);
        return { el: btn, insert: () => insertFact(view, fact) };
      });
      moveSlider(session);
      return { dom };
    },
  };
}

/* 玻璃态滑块定位：把滑块背景移到当前高亮项的位置（平滑过渡由 CSS transition 完成）。
 * 用 requestAnimationFrame 等 DOM 布局完成后再取 offsetTop/offsetHeight，避免首次渲染时取到 0。 */
function moveSlider(session) {
  const slider = session.slider;
  const items = session.items;
  if (!slider || !items || !items.length) return;
  const active = items[session.active];
  if (!active || !active.el) return;
  const el = active.el;
  requestAnimationFrame(() => {
    if (!session.slider || !session.items || !session.items[session.active]) return;
    const cur = session.items[session.active];
    if (!cur || !cur.el) return;
    slider.style.height = cur.el.offsetHeight + "px";
    slider.style.transform = "translateY(" + cur.el.offsetTop + "px)";
    slider.classList.add("is-visible");
  });
}

function insertFact(view, fact) {
  const session = getSession(view);
  if (!session || !session.tooltip || session.justInserted) return;
  session.justInserted = true;
  const info = session.tooltip;
  const pos = info.pos;
  const value = String(fact.indicator_value);

  /* B 类缺值：光标停在指标名末尾，直接在光标处插入真实数值（无【】可替换）。 */
  if (info.mode === "metric_no_value") {
    view.dispatch({
      changes: { from: pos, insert: value },
      selection: { anchor: pos + value.length },
      scrollIntoView: true,
      effects: hideInlineTooltip.of(),
    });
    session.tooltip = null;
    session.items = [];
    if (session.onInsert) {
      try { session.onInsert(fact, info.res); } catch (e) { /* ignore */ }
    }
    return;
  }

  /* 占位符「【」：替换【…】为目标数值 */
  const line = view.state.doc.lineAt(pos);
  const lineText = line.text;
  const openIdxInLine = lineText.lastIndexOf("【", pos - line.from);
  if (openIdxInLine < 0) {
    view.dispatch({ effects: hideInlineTooltip.of() });
    session.tooltip = null;
    session.items = [];
    return;
  }
  const from = line.from + openIdxInLine + 1; // 【 之后
  view.dispatch({
    changes: { from, to: pos, insert: value + "】" },
    selection: { anchor: from + value.length + 1 },
    scrollIntoView: true,
    effects: hideInlineTooltip.of(),
  });
  session.tooltip = null;
  session.items = [];
  if (session.onInsert) {
    try { session.onInsert(fact, info.res); } catch (e) { /* ignore */ }
  }
}

/* 指标名前缀下拉选中：用全字典指标名替换光标前已输入的前缀（Navicat 列名补全风）。 */
function insertMetricName(view, from, name) {
  const session = getSession(view);
  if (!session || !session.tooltip || session.justInserted) return;
  session.justInserted = true;
  const head = view.state.selection.main.head;
  view.dispatch({
    changes: { from, to: head, insert: name },
    selection: { anchor: from + name.length },
    scrollIntoView: true,
    effects: hideInlineTooltip.of(),
  });
  session.tooltip = null;
  session.items = [];
}

/* ===== 上下文波浪线（门店/日期/指标/占位符）=====
 * 仅当前行（光标所在行）统一红色波浪线，标记门店/日期/指标/占位符。 */
const WAVE_DECO = Decoration.mark({ class: "store-ac-wave" });

function buildSquiggles(view, engine, settings) {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const lineText = line.text;
  if (!lineText.trim()) return Decoration.none;
  const marks = contextMarks(lineText, engine.index.dim1Values, engine.index.indicatorNames);
  if (!marks.length) return Decoration.none;
  const builder = new RangeSetBuilder();
  for (const m of marks) {
    builder.add(line.from + m.start, line.from + m.end, WAVE_DECO);
  }
  return builder.finish();
}

function squiggleViewPlugin(engineProvider, settingsProvider) {
  return ViewPlugin.fromClass(
    class {
      constructor(view) {
        const engine = engineProvider();
        this.decorations =
          engine && engine.isReady() ? buildSquiggles(view, engine, settingsProvider()) : Decoration.none;
      }
      update(update) {
        if (!update.docChanged && !update.selectionSet) return;
        const engine = engineProvider();
        this.decorations =
          engine && engine.isReady() ? buildSquiggles(update.view, engine, settingsProvider()) : Decoration.none;
      }
    },
    { decorations: (plugin) => plugin.decorations }
  );
}

/* Tab 补全：光标位于某条 B 类缺值标记的指标名末尾（或内部）时，
 * 用全文 analyze（与网页端同一检索链）取该请求的真实事实，插入首个候选数值。 */
function tabComplete(view, engine, settings, onInsert) {
  const head = view.state.selection.main.head;
  const text = view.state.doc.toString();
  const marks = missingValueMarks(text, engine.index.indicatorNames);
  if (!marks.length) return false;
  const target = bClassAtHead(marks, head, text);
  if (!target) return false;
  const r = engine.analyze(text, {
    semantic: settings.semanticEnabled,
    semanticK: settings.semanticK || 3,
    semanticMinScore: settings.semanticMinScore,
    detectMetricWithoutValue: settings.detectMetricWithoutValue,
  });
  const dr = (r && r.data_requests || []).find(
    (d) =>
      d.request.kind === "metric_no_value" &&
      d.request.metric_pos &&
      d.request.metric_pos[1] === target.end
  );
  if (!dr) return false;
  const facts = (dr.result && dr.result.facts) || [];
  if (!facts.length) {
    new Notice("NO_RESULT：真实数据里没有「" + target.metric + "」的记录，不编造数值。");
    return true;
  }
  const fact = facts[0];
  const value = String(fact.indicator_value);
  view.dispatch({
    changes: { from: head, insert: value },
    selection: { anchor: head + value.length },
    scrollIntoView: true,
    effects: hideInlineTooltip.of(),
  });
  if (onInsert) {
    try {
      onInsert(fact, dr.result);
    } catch (e) {
      /* 历史记录失败不影响插入 */
    }
  }
  return true;
}

function inlineSuggestExtension(engineProvider, settingsProvider, onInsert, onTabInsert) {
  const tooltipField = StateField.define({
    create() {
      return null;
    },
    update(tooltip, tr) {
      for (const effect of tr.effects) {
        if (effect.is(hideInlineTooltip)) return null;
      }
      /* 打字或**移动光标**都重算（Navicat 手感：光标摆到指标名上就弹下拉） */
      if (!tr.docChanged && !tr.selectionSet) return tooltip;
      const settings = settingsProvider();
      const engine = engineProvider();
      if (!engine || !engine.isReady()) return null;
      if (!settings.inlineSuggest && !settings.detectMetricWithoutValue) return null;
      const head = tr.state.selection.main.head;
      const fullText = tr.state.doc.toString();
      const info = computeDropdownInfo(fullText, head, settings, engine);
      if (!info) return null;
      /* 情形没变（同一处、同一候选集）→ 沿用现有 tooltip，避免光标移动时反复重建 DOM */
      if (
        tooltip &&
        info.kind === tooltip.kind &&
        info.mode === tooltip.mode &&
        info.pos === tooltip.pos
      ) {
        if (info.kind === "metrics" && tooltip.metrics && info.metrics.join("|") === tooltip.metrics.join("|")) {
          return tooltip;
        }
        if (
          info.kind === "values" &&
          tooltip.res &&
          info.res &&
          tooltip.res.state === info.res.state &&
          (tooltip.res.facts || []).length === (info.res.facts || []).length
        ) {
          return tooltip;
        }
      }
      return Object.assign({ onInsert }, info);
    },
    provide: (f) => showTooltip.from(f, (v) => (v ? tooltipSpec(v) : null)),
  });

  const inlineKeymap = Prec.highest(
    keymap.of([
      {
        key: "Tab",
        run: (view) => {
          /* 优先：下拉弹窗可见且有候选 → 插入当前选中项（Tab 上屏） */
          const session = getSession(view);
          if (session && session.tooltip && session.items.length) {
            const item = session.items[session.active];
            if (item) {
              item.insert();
              return true;
            }
          }
          /* 其次：B 类缺值（指标名后无数值，光标在指标名末尾）→ Tab 补全首个候选 */
          const engine = engineProvider();
          if (!engine || !engine.isReady()) return false;
          const settings = settingsProvider();
          if (!settings.detectMetricWithoutValue) return false;
          return tabComplete(view, engine, settings, onTabInsert || onInsert);
        },
      },
      {
        key: "ArrowDown",
        run: (view) => {
          const session = getSession(view);
          if (!session || !session.tooltip || session.items.length <= 1) return false;
          session.active = (session.active + 1 + session.items.length) % session.items.length;
          session.items.forEach((it, i) => it.el.classList.toggle("is-active", i === session.active));
          moveSlider(session);
          return true;
        },
      },
      {
        key: "ArrowUp",
        run: (view) => {
          const session = getSession(view);
          if (!session || !session.tooltip || session.items.length <= 1) return false;
          session.active = (session.active - 1 + session.items.length) % session.items.length;
          session.items.forEach((it, i) => it.el.classList.toggle("is-active", i === session.active));
          moveSlider(session);
          return true;
        },
      },
      {
        key: "Enter",
        run: (view) => {
          const session = getSession(view);
          if (!session || !session.tooltip || !session.items.length || session.justInserted) return false;
          const item = session.items[session.active];
          if (item) { item.insert(); return true; }
          return false;
        },
      },
      {
        key: "Escape",
        run: (view) => {
          const session = getSession(view);
          if (!session || !session.tooltip) return false;
          view.dispatch({ effects: hideInlineTooltip.of() });
          return true;
        },
      },
    ])
  );

  return [tooltipField, inlineKeymap, squiggleViewPlugin(engineProvider, settingsProvider)];
}

module.exports = { inlineSuggestExtension };
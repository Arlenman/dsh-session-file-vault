#!/usr/bin/env node
/**
 * 新功能离线验收：标签配色 / 1-2-3 分列 / 左侧时间轴 / 收藏爱心 / 设置弹窗与同步请求。
 *
 * 与 test-client-panel.mjs 同一套载入方式（vm 跑 lib/client.js、真 React 静态渲染），
 * 但多出一个「假 React」载入通道：设置弹窗内部有 useState，静态渲染没法触发按钮，
 * 而 renderToStaticMarkup 之外的 hook 调用会报 Invalid hook call。
 * 假 React 用「按调用序位置化」的 useState + 记录 fetch 调用，就能真的点一次「保存 / 立即同步」，
 * 断言它发出的 URL 与请求体 —— 这是静态 DOM 断言永远覆盖不到的那一半。
 *
 * 用法：node scripts/test-features.mjs
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRATCH = 'D:\\dsh-work\\_react-scratch';

const req = createRequire(path.join(SCRATCH, 'anchor.cjs'));
let React;
let ReactDOMServer;
try {
  React = req('react');
  ReactDOMServer = req('react-dom/server');
} catch (e) {
  console.error('无法从 ' + SCRATCH + ' 加载 react / react-dom：' + e.message);
  process.exit(2);
}

const source = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

/* ------------------------------------------------------------------ 断言 */

let passed = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) passed += 1;
  else failures.push(label + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
}
function eq(actual, expected, label) {
  ok(actual === expected, label, { actual, expected });
}
function includes(hay, needle, label) {
  const text = String(hay == null ? '' : hay);
  ok(text.indexOf(needle) >= 0, label, { needle, sample: text.slice(0, 240) });
}
function excludes(hay, needle, label) {
  const text = String(hay == null ? '' : hay);
  ok(text.indexOf(needle) < 0, label, { needle, sample: text.slice(0, 240) });
}
function matches(hay, re, label) {
  ok(re.test(String(hay == null ? '' : hay)), label, { re: String(re), sample: String(hay).slice(0, 240) });
}

/* ------------------------------------------------------------ 假 React */

/**
 * 极简 React 替身：足够跑 SettingsModal 这种「几个 useState + 一个 handler」的组件。
 * useState 按调用序位置化（plan 里给初值），setState 记一笔不重渲染 ——
 * 我们关心的是「点下去发了什么请求」，不是再渲染出来的样子。
 */
function makeFakeReact() {
  const plan = [];
  const setLog = [];
  let cursor = 0;
  const hooks = [];

  const fake = {
    createElement(type, props, ...children) {
      const merged = Object.assign({}, props || {});
      if (children.length === 1) merged.children = children[0];
      else if (children.length > 1) merged.children = children;
      return { type, props: merged };
    },
    Component: class Component {
      constructor(props) {
        this.props = props;
        this.state = {};
      }
      setState(next) {
        Object.assign(this.state, next || {});
      }
    },
    Fragment: 'Fragment',
    useState(init) {
      const idx = cursor;
      cursor += 1;
      if (hooks.length <= idx) hooks.push(typeof init === 'function' ? init() : init);
      const setter = (next) => {
        hooks[idx] = typeof next === 'function' ? next(hooks[idx]) : next;
        setLog.push({ idx, value: next });
      };
      return [hooks[idx], setter];
    },
    useCallback(fn) {
      return fn;
    },
    useEffect() {
      /* 不跑副作用 */
    },
    useRef(init) {
      return { current: init };
    },
  };

  return {
    react: fake,
    /** 每次渲染前复位 hook 游标；plan 用来给某些位置预置状态。 */
    reset(initial) {
      cursor = 0;
      hooks.length = 0;
      if (Array.isArray(initial)) for (const v of initial) hooks.push(v);
    },
    hooks,
    setLog,
  };
}

/* ------------------------------------------------------------ 载入 bundle */

function loadBundle(reactImpl, extraWindow) {
  let captured = null;
  const sandboxWindow = Object.assign(
    {
      __SFV_TEST__: true,
      __ModuleLoader__: {
        load(def) {
          captured = def;
        },
      },
    },
    extraWindow || {},
  );
  const context = vm.createContext({
    window: sandboxWindow,
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      throw new Error('offline-test: 未安装 fetch');
    },
    Date,
    Math,
    JSON,
    Set,
    Map,
    Promise,
    encodeURIComponent,
    isFinite,
    Array,
    Object,
  });
  vm.runInContext(source, context, { filename: 'lib/client.js' });
  if (!captured) throw new Error('bundle 没有调用 window.__ModuleLoader__.load');
  const exported = captured.factory((id) => {
    if (id === 'react') return reactImpl;
    throw new Error('offline-test: 未知模块 ' + id);
  });
  return { exported, internals: sandboxWindow.__SFV_INTERNALS__ };
}

const loaded = loadBundle(React, {});
const I = loaded.internals;
const C = I.constants;

/* ------------------------------------------------------------ 元素遍历 */

function html(element) {
  return ReactDOMServer.renderToStaticMarkup(element);
}

function walk(node, visit) {
  if (node === null || node === undefined || typeof node === 'boolean') return;
  if (Array.isArray(node)) {
    for (const n of node) walk(n, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node);
  const type = node.type;
  const props = node.props || {};
  if (typeof type === 'function' && !(type.prototype && type.prototype.isReactComponent)) {
    let rendered;
    try {
      rendered = type(props);
    } catch (e) {
      return;
    }
    walk(rendered, visit);
    return;
  }
  walk(props.children, visit);
}

function findAll(element, predicate) {
  const out = [];
  walk(element, (node) => {
    if (predicate(node, node.props || {})) out.push(node);
  });
  return out;
}

function textOf(node) {
  let out = '';
  walk(node, (n) => {
    const ch = n.props && n.props.children;
    if (typeof ch === 'string') out += ch;
    else if (Array.isArray(ch)) {
      for (const c of ch) if (typeof c === 'string') out += c;
    }
  });
  return out;
}

function classOf(node) {
  const c = node.props && node.props.className;
  return typeof c === 'string' ? c : '';
}
function hasClass(node, cls) {
  return classOf(node).split(/\s+/).indexOf(cls) >= 0;
}

/* ------------------------------------------------------------ 样张数据 */

const T1 = new Date(2026, 9, 31, 19, 48).getTime(); // 2026-10-31 19:48
const T2 = new Date(2026, 4, 3, 8, 5).getTime(); // 2026-05-03 08:05

const TYPE_CATS = [
  { key: 'doc', label: '文档', order: 0 },
  { key: 'image', label: '图片', order: 1 },
  { key: 'code', label: '代码', order: 2 },
  { key: 'other', label: '其它', order: 3 },
];

function rec(over) {
  return Object.assign(
    {
      id: 'x',
      name: 'file.md',
      path: 'D:\\x\\file.md',
      dir: 'D:\\x',
      ext: 'md',
      sizeBytes: 2048,
      mtimeMs: T1,
      exists: true,
      firstPresentedAt: T1,
      lastPresentedAt: T1,
      presentCount: 1,
      descriptions: [],
      tags: { type: 'doc', typeLabel: '文档', content: [] },
      userTags: { type: '', content: [], date: '' },
      sessionCount: 1,
      lastSession: null,
    },
    over || {},
  );
}

const REC_A = rec({
  id: 'a1',
  name: '季度报表.md',
  sizeBytes: 2048,
  lastPresentedAt: T1,
  presentCount: 2,
  tags: { type: 'doc', typeLabel: '文档', content: ['报表', '财务'] },
});
const REC_B = rec({
  id: 'b2',
  name: '营收图表.png',
  ext: 'png',
  sizeBytes: 1048576,
  lastPresentedAt: T2,
  tags: { type: 'image', typeLabel: '图片', content: ['报表', '可视化'] },
});
const REC_C = rec({
  id: 'c3',
  name: 'sync.mjs',
  ext: 'mjs',
  sizeBytes: 300,
  lastPresentedAt: T2,
  exists: false,
  tags: { type: 'code', typeLabel: '代码', content: ['同步'] },
});

const RECORDS = [REC_A, REC_B, REC_C];

function makeData(over) {
  return Object.assign(
    {
      ready: true,
      version: 2,
      rebuilding: false,
      progress: null,
      lastError: null,
      stale: false,
      records: RECORDS,
      favorites: [],
      lastSyncAt: null,
      settings: { syncDir: '', syncMode: 'all', syncTypes: [], updatedAt: 0 },
      meta: { typeCategories: TYPE_CATS, total: RECORDS.length, existsCount: 2, missingCount: 1, generatedAt: T1 },
    },
    over || {},
  );
}

const EMPTY_FILTER = { text: '', type: '', tags: [], from: '', to: '', sort: 'recent' };

function viewProps(over) {
  return Object.assign(
    {
      view: { loading: false, error: null, data: makeData() },
      filter: EMPTY_FILTER,
      busy: '',
      nowMs: T1,
      openId: '',
      details: {},
      mode: 'list',
      graphDim: 'tag',
      graphView: { k: 1, x: 0, y: 0 },
      settingsOpen: false,
      cols: 1,
      onToggleRow() {},
      onLoadDetail() {},
      onReload() {},
      onRebuild() {},
      onText() {},
      onType() {},
      onToggleTag() {},
      onTagQuery() {},
      onTagOpen() {},
      onTagBlur() {},
      onFrom() {},
      onTo() {},
      onSort() {},
      onClear() {},
      onMode() {},
      onGraphDim() {},
      onPickFile() {},
      onGraphPanStart() {},
      onGraphClickCapture() {},
      onGraphZoom() {},
      onGraphReset() {},
      onCols() {},
      onOpenSettings() {},
      onCloseSettings() {},
      onFavorite() {},
      onSettingsSaved() {},
      onSynced() {},
    },
    over || {},
  );
}

function panel(over) {
  return React.createElement(I.PanelView, viewProps(over));
}

/* ================================================================== A. 标签配色 */

{
  const s1 = I.tagStyle('报表');
  const s2 = I.tagStyle('报表');
  const s3 = I.tagStyle('财务');
  eq(JSON.stringify(s1), JSON.stringify(s2), 'A1 同一个标签两次取色完全一致（不会一闪一个色）');
  ok(JSON.stringify(s1) !== JSON.stringify(s3), 'A2 不同标签取到不同背景色');
  matches(s1.background, /^hsla\(\d{1,3}, 70%, 52%, \.17\)$/, 'A3 标签底色是半透明 hsla（浅色/深色主题都能用）');
  const hue1 = I.hueOf('报表');
  ok(hue1 >= 0 && hue1 < 360, 'A4 色相落在 0–359', { hue1 });
  eq(I.hueOf(''), I.hueOf(''), 'A5 空标签取色不抛错且稳定');

  // 类型色：固定映射，不随文本变化
  eq(I.typeStyle('doc').background.indexOf('215') >= 0, true, 'A6 文档类型用固定色相 215');
  eq(I.typeStyle('image').background.indexOf('285') >= 0, true, 'A7 图片类型用固定色相 285');
  ok(I.typeStyle('doc').background !== I.typeStyle('code').background, 'A8 不同类型颜色不同');
  eq(I.typeStyle('nonexistent').background, I.typeStyle('other').background, 'A9 未知类型回落到「其它」色');

  // 渲染到真实行里：类型标签与内容标签都带 inline 背景
  const el = panel({});
  const typeTags = findAll(el, (n) => hasClass(n, 'sfv-tag') && textOf(n).indexOf('文档') >= 0);
  ok(typeTags.length > 0, 'A10 行里渲染出类型标签');
  ok(typeTags.length > 0 && typeTags[0].props.style && typeTags[0].props.style.background, 'A11 类型标签带 inline 背景色', typeTags[0] && typeTags[0].props.style);
  const contentTags = findAll(el, (n) => hasClass(n, 'sfv-tag') && textOf(n).indexOf('报表') >= 0);
  ok(contentTags.length > 0, 'A12 行里渲染出内容标签');
  ok(contentTags.length > 0 && contentTags[0].props.style && contentTags[0].props.style.background, 'A13 内容标签带 inline 背景色');
  eq(contentTags.length > 0 && contentTags[0].props.style.color, undefined, 'A14 内容标签只设背景、不设文字色（跟随主题继承）');

  // 手动标签仍要能看出来（金色描边），不能因为配色丢了语义
  const manualRec = rec({ id: 'm1', tags: { type: 'doc', typeLabel: '文档', content: ['报表'] }, userTags: { type: '', content: ['报表'], date: '' } });
  const elM = React.createElement(I.PanelView, viewProps({ view: { loading: false, error: null, data: makeData({ records: [manualRec] }) } }));
  const manualTag = findAll(elM, (n) => hasClass(n, 'sfv-tag') && textOf(n) === '报表')[0];
  ok(manualTag && hasClass(manualTag, 'sfv-manual'), 'A15 手动标签带 sfv-manual 标记（金色描边）');
}

/* ================================================================== B. 分列 */

{
  eq(JSON.stringify(I.COLS_ALLOWED), JSON.stringify([1, 2, 3]), 'B1 只允许 1 / 2 / 3 列');

  const c1 = html(panel({ cols: 1 }));
  const c2 = html(panel({ cols: 2 }));
  const c3 = html(panel({ cols: 3 }));
  includes(c1, 'sfv-list sfv-cols-1', 'B2 cols=1 → 列表带 sfv-cols-1');
  includes(c2, 'sfv-list sfv-cols-2', 'B3 cols=2 → 列表带 sfv-cols-2');
  includes(c3, 'sfv-list sfv-cols-3', 'B4 cols=3 → 列表带 sfv-cols-3');
  includes(html(panel({ cols: 7 })), 'sfv-cols-1', 'B5 非法列数回落 1 列');
  includes(html(panel({ cols: undefined })), 'sfv-cols-1', 'B6 没传列数默认 1 列');

  // 工具栏上的三个按钮
  const calls = [];
  const el = panel({ onCols: (n) => calls.push(n) });
  const btns = findAll(el, (n) => hasClass(n, 'sfv-viewswitch') === false && n.type === 'button' && /^\d 列$/.test(textOf(n)));
  eq(btns.length, 3, 'B7 工具栏有 1/2/3 列三个按钮', btns.map((b) => textOf(b)));
  const two = btns.find((b) => textOf(b) === '2 列');
  ok(Boolean(two) && typeof two.props.onClick === 'function', 'B8 「2 列」按钮挂了点击处理器');
  if (two) two.props.onClick({});
  eq(calls[calls.length - 1], 2, 'B9 点「2 列」回传 2');
  const on = findAll(el, (n) => n.type === 'button' && textOf(n) === '1 列' && hasClass(n, 'sfv-on'));
  ok(on.length === 1, 'B10 当前列数按钮高亮（默认 1 列）');

  // localStorage 持久化
  const store = {};
  const withLs = loadBundle(React, {
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => {
        store[k] = String(v);
      },
    },
  });
  eq(withLs.internals.readCols(), 1, 'B11 没有存过值 → 默认 1 列');
  withLs.internals.writeCols(3);
  eq(store['dsh-session-file-vault:cols'], '3', 'B12 写列数进 localStorage 的固定 key');
  eq(withLs.internals.readCols(), 3, 'B13 读回刚写的 3 列');
  withLs.internals.writeCols(9);
  eq(withLs.internals.readCols(), 1, 'B14 存了非法值也回落 1 列');
}

/* ================================================================== C. 时间轴 */

{
  const st = I.stampOf(T1);
  eq(st.md, '10-31', 'C1 stampOf 月份-日期补零');
  eq(st.hm, '19:48', 'C2 stampOf 时:分补零');
  eq(st.full, '2026-10-31 19:48', 'C3 stampOf 完整时间带年份');

  const el = panel({});
  const tls = findAll(el, (n) => hasClass(n, 'sfv-tl'));
  eq(tls.length, RECORDS.length, 'C4 每行一个时间轴条目');
  const dots = findAll(el, (n) => hasClass(n, 'sfv-tl-dot'));
  eq(dots.length, RECORDS.length, 'C5 每条一个时间轴节点');
  const when = findAll(el, (n) => hasClass(n, 'sfv-tl-when'));
  eq(when.length, RECORDS.length, 'C6 每条一个左侧时间块');
  const firstWhen = when[0];
  includes(textOf(firstWhen), '10-31', 'C7 左侧显示具体日期（不是「3 天前」）');
  includes(textOf(firstWhen), '19:48', 'C8 左侧显示具体时分');
  includes(firstWhen.props.title || '', '2026-10-31 19:48', 'C9 hover 的 title 给完整时间戳');

  const text = html(el);
  excludes(text, '分钟前', 'C10 不再出现相对时间「分钟前」');
  excludes(text, '小时前', 'C11 不再出现相对时间「小时前」');
  excludes(text, '天前', 'C12 不再出现相对时间「天前」');

  // 时间在左：序列化 HTML 里时间块出现在行卡片之前
  const iTl = text.indexOf('sfv-tl-when');
  const iRow = text.indexOf('sfv-row"');
  ok(iTl >= 0 && iRow >= 0 && iTl < iRow, 'C13 时间块在文件行左侧（DOM 顺序在前）', { iTl, iRow });

  // 缺失文件照样有时间轴
  const cWhen = when.find((w) => textOf(w).indexOf('05-03') >= 0);
  ok(Boolean(cWhen), 'C14 缺失的文件也有时间（08:05 那条）');
}

/* ================================================================== D. 收藏爱心 */

{
  const plain = html(panel({}));
  excludes(plain, 'sfv-heart', 'D1 非手动模式不显示爱心');

  const manual = html(
    panel({ view: { loading: false, error: null, data: makeData({ settings: { syncDir: 'D:\\sync', syncMode: 'manual', syncTypes: [] } }) } }),
  );
  includes(manual, 'sfv-heart', 'D2 手动模式显示爱心');
  const hearts = findAll(
    panel({ view: { loading: false, error: null, data: makeData({ settings: { syncDir: '', syncMode: 'manual', syncTypes: [] } }) } }),
    (n) => hasClass(n, 'sfv-heart'),
  );
  eq(hearts.length, RECORDS.length, 'D3 每个文件一个爱心');
  eq(textOf(hearts[0]), '♡', 'D4 未收藏显示空心爱心');
  eq(hasClass(hearts[0], 'sfv-on'), false, 'D5 未收藏没有红底类');

  const favData = makeData({
    favorites: ['a1'],
    settings: { syncDir: '', syncMode: 'manual', syncTypes: [] },
  });
  const favEl = panel({ view: { loading: false, error: null, data: favData } });
  const favHearts = findAll(favEl, (n) => hasClass(n, 'sfv-heart'));
  eq(textOf(favHearts[0]), '♥', 'D6 已收藏显示实心爱心');
  ok(hasClass(favHearts[0], 'sfv-on'), 'D7 已收藏带 sfv-on（CSS 里是红底白字）');
  eq(textOf(favHearts[1]), '♡', 'D8 未收藏的那条仍是空心');

  // 点爱心：回传 (id, true)，且不冒泡到行（否则会展开详情）
  const calls = [];
  const toggles = [];
  const clickEl = panel({
    view: {
      loading: false,
      error: null,
      data: makeData({ settings: { syncDir: '', syncMode: 'manual', syncTypes: [] } }),
    },
    onFavorite: (id, next) => calls.push([id, next]),
    onToggleRow: (id) => toggles.push(id),
  });
  const btn = findAll(clickEl, (n) => hasClass(n, 'sfv-heart'))[0];
  let stopped = 0;
  btn.props.onClick({ stopPropagation: () => { stopped += 1; } });
  eq(JSON.stringify(calls[0]), JSON.stringify(['a1', true]), 'D9 点空心爱心 → onFavorite(id, true)');
  eq(stopped, 1, 'D10 爱心点击调用了 stopPropagation');
  eq(toggles.length, 0, 'D11 爱心点击没有触发整行展开');

  // 已收藏再点 → false（取消）
  const favBtn = findAll(favEl, (n) => hasClass(n, 'sfv-heart'))[0];
  const calls2 = [];
  const favEl2 = panel({
    view: { loading: false, error: null, data: favData },
    onFavorite: (id, next) => calls2.push([id, next]),
  });
  findAll(favEl2, (n) => hasClass(n, 'sfv-heart'))[0].props.onClick({ stopPropagation() {} });
  eq(JSON.stringify(calls2[0]), JSON.stringify(['a1', false]), 'D12 点实心爱心 → onFavorite(id, false)');
  ok(Boolean(favBtn), 'D13 已收藏那行能找到爱心');
}

/* ================================================================== E. 设置入口与弹窗 */

{
  const calls = [];
  const el = panel({ onOpenSettings: () => calls.push('open') });
  const gear = findAll(el, (n) => n.type === 'button' && textOf(n).indexOf('设置') >= 0)[0];
  ok(Boolean(gear), 'E1 工具栏有「设置」按钮');
  gear.props.onClick({});
  eq(calls[0], 'open', 'E2 点设置 → onOpenSettings');

  // 弹窗未打开时不应渲染
  excludes(html(panel({})), 'sfv-modal', 'E3 默认不渲染设置弹窗');

  const modal = html(panel({ settingsOpen: true }));
  includes(modal, 'sfv-modal', 'E4 settingsOpen 时渲染弹窗');
  includes(modal, '同步目录', 'E5 弹窗里有「同步目录」');
  includes(modal, '同步范围', 'E6 弹窗里有「同步范围」');
  includes(modal, '全部文件', 'E7 范围选项含「全部文件」');
  includes(modal, '按类型', 'E8 范围选项含「按类型」');
  includes(modal, '手动收藏', 'E9 范围选项含「手动收藏」');
  includes(modal, '立即同步', 'E10 弹窗里有「立即同步」按钮');
  includes(modal, '保存设置', 'E11 弹窗里有「保存设置」按钮');
  includes(modal, 'D:\\dsh-vault-sync', 'E12 目录输入框有示例占位');

  // 手动模式的说明文案
  const manualModal = html(
    panel({ settingsOpen: true, settings: { syncDir: '', syncMode: 'manual', syncTypes: [] } }),
  );
  includes(manualModal, '红底', 'E13 手动模式说明提到红底 ♥');

  // 按类型模式才出现类型多选
  const allModal = html(panel({ settingsOpen: true, settings: { syncDir: '', syncMode: 'all', syncTypes: [] } }));
  excludes(allModal, '文件类型（可多选）', 'E14 全部文件模式不显示类型多选');
  const typeModal = html(
    panel({ settingsOpen: true, settings: { syncDir: '', syncMode: 'type', syncTypes: ['doc'] } }),
  );
  includes(typeModal, '文件类型（可多选）', 'E15 按类型模式显示类型多选');
  includes(typeModal, '文档', 'E16 类型多选列出分类');
}

/* ================================================== F. 设置弹窗的真调用（假 React） */

async function sectionF() {
  const fake = makeFakeReact();
  const fetchCalls = [];
  const fetchImpl = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ ok: true, settings: {}, report: { dir: 'D:\\sync', copied: 2, updated: 1, skipped: 0, failed: 0, matched: 3, errors: [] } });
      },
    };
  };

  // 用同一个 bundle 但换成假 React + 可编程 fetch
  const fakeLoaded = loadBundle(fake.react, {});
  // 重新注入 fetch：bundle 里的 apiPost 走全局 fetch，所以换 context 里的实现最直接
  const fakeLoaded2 = (() => {
    let captured = null;
    const sandboxWindow = {
      __SFV_TEST__: true,
      __ModuleLoader__: { load: (d) => { captured = d; } },
    };
    const ctx = vm.createContext({
      window: sandboxWindow,
      document: undefined,
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      fetch: fetchImpl,
      Date,
      Math,
      JSON,
      Set,
      Map,
      Promise,
      encodeURIComponent,
      isFinite,
      Array,
      Object,
    });
    vm.runInContext(source, ctx, { filename: 'lib/client.js' });
    captured.factory((id) => (id === 'react' ? fake.react : (() => { throw new Error('未知模块 ' + id); })()));
    return { internals: sandboxWindow.__SFV_INTERNALS__ };
  })();
  ok(Boolean(fakeLoaded2.internals), 'F1 假 React 载入通道可用（拿到 internals）');
  ok(Boolean(fakeLoaded && fakeLoaded.internals), 'F2 假 React 首次载入也成功');

  const Modal = fakeLoaded2.internals.SettingsModal;
  const saved = [];
  const synced = [];

  const mkModal = (settingsOver) => {
    fake.reset([
      (settingsOver && settingsOver.syncDir) || 'D:\\sync',
      (settingsOver && settingsOver.syncMode) || 'all',
      (settingsOver && settingsOver.syncTypes) || [],
      '',
      '',
      null,
    ]);
    return Modal({
      settings: settingsOver || { syncDir: 'D:\\sync', syncMode: 'all', syncTypes: [] },
      categories: TYPE_CATS,
      lastSyncAt: null,
      onClose() {},
      onSaved: (s) => saved.push(s),
      onSynced: (r) => synced.push(r),
    });
  };

  // F3-F6：保存设置 → POST /settings，body 三个字段齐全
  {
    fetchCalls.length = 0;
    const el = mkModal({ syncDir: 'D:\\sync2', syncMode: 'type', syncTypes: ['doc'] });
    const saveBtn = findAll(el, (n) => n.type === 'button' && textOf(n) === '保存设置')[0];
    ok(Boolean(saveBtn), 'F3 找到「保存设置」按钮');
    ok(Boolean(saveBtn) && typeof saveBtn.props.onClick === 'function', 'F4 保存按钮挂了处理器');
    if (saveBtn) await saveBtn.props.onClick({});
    eq(fetchCalls.length, 1, 'F5 点保存只发一次请求', fetchCalls.length);
    const call = fetchCalls[0] || { url: '', opts: {} };
    eq(call.url, '/api/session-file-vault/settings', 'F6 保存打到 /settings');
    eq(call.opts.method, 'POST', 'F7 保存是 POST');
    eq(call.opts.headers && call.opts.headers['content-type'], 'application/json', 'F8 保存带 JSON content-type');
    const body = JSON.parse(call.opts.body);
    eq(body.syncDir, 'D:\\sync2', 'F9 请求体带同步目录');
    eq(body.syncMode, 'type', 'F10 请求体带同步范围');
    eq(JSON.stringify(body.syncTypes), JSON.stringify(['doc']), 'F11 请求体带类型列表');
    await new Promise((r) => setTimeout(r, 0));
    eq(saved.length, 1, 'F12 保存成功回调 onSaved');
  }

  // F13-F15：立即同步 → POST /sync
  {
    fetchCalls.length = 0;
    const el = mkModal({ syncDir: 'D:\\sync', syncMode: 'all', syncTypes: [] });
    const syncBtn = findAll(el, (n) => n.type === 'button' && textOf(n) === '立即同步')[0];
    ok(Boolean(syncBtn), 'F13 找到「立即同步」按钮');
    if (syncBtn) await syncBtn.props.onClick({});
    eq(fetchCalls.length, 1, 'F14 点同步只发一次请求');
    eq(fetchCalls[0] && fetchCalls[0].url, '/api/session-file-vault/sync', 'F15 同步打到 /sync');
    await new Promise((r) => setTimeout(r, 0));
    eq(synced.length, 1, 'F16 同步成功回调 onSynced');
    eq(synced[0] && synced[0].copied, 2, 'F17 回调带同步结果');
  }

  // F18：按类型但一个类型都没选 → 本地就拦住，不发请求
  {
    fetchCalls.length = 0;
    const el = mkModal({ syncDir: 'D:\\sync', syncMode: 'type', syncTypes: [] });
    const saveBtn = findAll(el, (n) => n.type === 'button' && textOf(n) === '保存设置')[0];
    await saveBtn.props.onClick({});
    eq(fetchCalls.length, 0, 'F18 类型没选就不发保存请求（本地拦住）');
    const msgs = fake.setLog.filter((x) => x.idx === 4).map((x) => String(x.value));
    ok(msgs.some((m) => m.indexOf('至少勾选') >= 0), 'F19 界面上给出「至少勾选一个文件类型」的提示', msgs);
  }

  // F20：目录为空时「立即同步」按钮是 disabled
  {
    fake.reset(['', 'all', [], '', '', null]);
    const el = Modal({
      settings: { syncDir: '', syncMode: 'all', syncTypes: [] },
      categories: TYPE_CATS,
      lastSyncAt: null,
      onClose() {},
      onSaved() {},
      onSynced() {},
    });
    const syncBtn = findAll(el, (n) => n.type === 'button' && textOf(n) === '立即同步')[0];
    eq(syncBtn.props.disabled, true, 'F20 目录为空时「立即同步」禁用');
  }

  // F21：请求失败时界面给出可读错误，不抛未捕获异常
  {
    const failCalls = [];
    let captured = null;
    const sandboxWindow = { __SFV_TEST__: true, __ModuleLoader__: { load: (d) => { captured = d; } } };
    const ctx = vm.createContext({
      window: sandboxWindow,
      document: undefined,
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      fetch: async () => ({
        ok: false,
        status: 400,
        async text() {
          return JSON.stringify({ ok: false, error: { code: 'no-sync-dir', message: '还没有设置同步目录' } });
        },
      }),
      Date,
      Math,
      JSON,
      Set,
      Map,
      Promise,
      encodeURIComponent,
      isFinite,
      Array,
      Object,
    });
    vm.runInContext(source, ctx, { filename: 'lib/client.js' });
    captured.factory((id) => (id === 'react' ? fake.react : (() => { throw new Error('x'); })()));
    const M2 = sandboxWindow.__SFV_INTERNALS__.SettingsModal;
    fake.reset(['D:\\sync', 'all', [], '', '', null]);
    const el = M2({
      settings: { syncDir: 'D:\\sync', syncMode: 'all', syncTypes: [] },
      categories: TYPE_CATS,
      onClose() {},
      onSaved() {},
      onSynced: (r) => failCalls.push(r),
    });
    const syncBtn = findAll(el, (n) => n.type === 'button' && textOf(n) === '立即同步')[0];
    await syncBtn.props.onClick({});
    await new Promise((r) => setTimeout(r, 0));
    const msgs = fake.setLog.filter((x) => x.idx === 4).map((x) => String(x.value));
    ok(msgs.some((m) => m.indexOf('同步失败') >= 0 && m.indexOf('还没有设置同步目录') >= 0), 'F21 同步失败把宿主给的错误原文显示出来', msgs);
    eq(failCalls.length, 0, 'F22 失败时不调用 onSynced（不会假装成功）');
  }
}

/* ------------------------------------------------------------------ 汇总 */

await sectionF();

console.log('');
console.log('新功能离线验证：' + passed + ' 通过，' + failures.length + ' 失败（共 ' + (passed + failures.length) + ' 项）');
if (failures.length) {
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');

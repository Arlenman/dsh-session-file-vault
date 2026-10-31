#!/usr/bin/env node
/**
 * 客户端半边离线验证（不启动 DSH、不连浏览器）。
 *
 * 做法：
 *  1. 用 vm 执行 lib/client.js（它是无 import/export 的普通脚本），
 *     先塞一个假的 window.__ModuleLoader__ 捕获 { id, factory }；
 *  2. factory 的 require('react') 交出真实的 react（从 scratch 目录加载），
 *     所以生成的是真 React 元素，可以用 react-dom/server 渲染成 HTML 断言；
 *  3. 面板视图层是纯函数（PanelView），直接喂各种 props 覆盖全部状态；
 *  4. 事件回调单独「真调用」一遍 —— 静态渲染永远不会触发 onClick，
 *     光看 HTML 会把 handler 写错/引用错名字这类 bug 全部漏掉。
 *
 * 用法：node scripts/test-client-panel.mjs [--dsh-home <path>]
 */

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCRATCH = 'D:\\dsh-work\\_react-scratch';

const argv = process.argv.slice(2);
function argOf(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const DSH_HOME = argOf('--dsh-home', process.env.DSH_HOME || 'C:\\Users\\98340\\.dsh');

/* ------------------------------------------------------------------ 断言 */

let passed = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    passed += 1;
  } else {
    failures.push(label + (detail === undefined ? '' : ' → ' + JSON.stringify(detail)));
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, { actual, expected });
}
function includes(hay, needle, label) {
  const text = String(hay == null ? '' : hay);
  ok(text.indexOf(needle) >= 0, label, { needle, sample: text.slice(0, 260) });
}
function excludes(hay, needle, label) {
  const text = String(hay == null ? '' : hay);
  ok(text.indexOf(needle) < 0, label, { needle, sample: text.slice(0, 260) });
}

/* ------------------------------------------------------------------ 环境 */

const req = createRequire(path.join(SCRATCH, 'anchor.cjs'));
let React;
let ReactDOMServer;
try {
  React = req('react');
  ReactDOMServer = req('react-dom/server');
} catch (e) {
  console.error('无法从 ' + SCRATCH + ' 加载 react / react-dom：' + e.message);
  console.error('请先在该目录 npm i react@18 react-dom@18');
  process.exit(2);
}

const source = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

/** 执行 bundle，返回被注册的 factory 的产物。 */
function loadBundle() {
  let captured = null;
  const sandboxWindow = {
    __SFV_TEST__: true,
    __ModuleLoader__: {
      load(def) {
        captured = def;
      },
    },
  };
  const context = vm.createContext({
    window: sandboxWindow,
    document: undefined,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: async () => {
      throw new Error('offline-test: fetch 不可用');
    },
    Date,
    Math,
    JSON,
    Set,
    Map,
    Promise,
    encodeURIComponent,
    isFinite,
  });
  vm.runInContext(source, context, { filename: 'lib/client.js' });

  if (!captured) throw new Error('bundle 没有调用 window.__ModuleLoader__.load');
  const fakeRequire = (id) => {
    if (id === 'react') return React;
    throw new Error('offline-test: 未知模块 ' + id);
  };
  const exported = captured.factory(fakeRequire);
  const internals = sandboxWindow.__SFV_INTERNALS__;
  return { def: captured, exported, internals };
}

function html(element) {
  return ReactDOMServer.renderToStaticMarkup(element);
}

/**
 * 递归遍历元素树，收集「元素的 props」。
 * 函数组件会被就地展开（它们都是纯函数），class 组件不展开。
 */
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

/** 找第一个满足条件的元素（className 命中 + 可选文本命中）。 */
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
    // 元素混排时（图标元素 + 文案 + 计数 span）children 是数组，
    // 只收数组里的字符串，否则含图标的按钮取不到自己的文案。
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

/* ------------------------------------------------------------------ 载入 */

const { def, exported, internals } = loadBundle();
const C = internals.constants;

/* ================================================================== A. 模块契约 */

eq(def.id, 'dsh-session-file-vault', 'A1 bundle id 等于包名');
ok(exported && typeof exported === 'object', 'A2 factory 返回对象');
ok(Array.isArray(exported.inject), 'A3 inject 是数组');
eq(JSON.stringify(exported.inject), JSON.stringify(['slots']), 'A4 inject 只写 slots（避免不存在的服务导致 web boot 致命框）');
eq(typeof exported.apply, 'function', 'A5 apply 是函数');
eq(typeof internals.PanelView, 'function', 'A6 测试钩子暴露 PanelView');
eq(typeof internals.selectRecords, 'function', 'A7 测试钩子暴露 selectRecords');
ok(internals.CSS.length > 2000, 'A8 CSS 有实质内容', internals.CSS.length);

const openBraces = (internals.CSS.match(/\{/g) || []).length;
const closeBraces = (internals.CSS.match(/\}/g) || []).length;
eq(openBraces, closeBraces, 'A9 CSS 花括号配平');

/* ================================================================== B. 槽位注册 */

function makeCtx(opts = {}) {
  const registrations = [];
  const disposed = [];
  const injectCalls = [];
  const ctx = {
    slots: {
      inject(slot, cb) {
        injectCalls.push(slot);
        if (opts.injectThrowsOn && opts.injectThrowsOn.indexOf(slot) >= 0) {
          throw new Error('slot "' + slot + '" is not declared');
        }
        let innerDisposed = false;
        const disposeInner = cb();
        return () => {
          if (innerDisposed) return;
          innerDisposed = true;
          if (typeof disposeInner === 'function') disposeInner();
          disposed.push(slot);
        };
      },
      register(options, component) {
        if (opts.registerThrowsOn && opts.registerThrowsOn === options.name) {
          throw new Error('slot "' + options.name + '" is not declared');
        }
        const rec = { options, component, live: true };
        registrations.push(rec);
        return () => {
          if (!rec.live) return;
          rec.live = false;
        };
      },
    },
  };
  return { ctx, registrations, disposed, injectCalls };
}

{
  const { ctx, registrations, injectCalls } = makeCtx();
  exported.apply(ctx);
  eq(injectCalls.length, 2, 'B1 申请了 2 个槽位（sidebar.panellist + main）');
  ok(injectCalls.indexOf('sidebar.panellist') >= 0, 'B2 申请 sidebar.panellist');
  ok(injectCalls.indexOf('main') >= 0, 'B3 申请 main');

  const panel = registrations.find((r) => r.options.name === 'sidebar.panellist');
  const main = registrations.find((r) => r.options.name === 'main');
  ok(panel, 'B4 侧边栏入口已注册');
  ok(main, 'B5 主面板已注册');
  if (panel) {
    eq(panel.options.id, C.PANEL_ID, 'B6 侧边栏 id 正确');
    eq(panel.options.order, C.SIDEBAR_ORDER, 'B7 侧边栏 order 正确');
    eq(panel.options.order, 50, 'B8 order = 50（排在 dsh-stock-ledger 的 30 之后）');
    eq(panel.options.label, '文件库', 'B9 侧边栏 label 正确');
    eq(typeof panel.component, 'function', 'B10 侧边栏图标是组件');
  }
  if (main) {
    eq(main.options.key, C.PANEL_ID, 'B11 main 的 key 与侧边栏 id 配对');
    eq(typeof main.component, 'function', 'B12 main 组件是函数');
  }
}

{
  // 重复 apply 必须不抛错，并且先清理上一代注册（否则真槽位会抛「重复注册」）
  const { ctx, registrations, disposed } = makeCtx();
  exported.apply(ctx);
  const firstCount = registrations.length;
  let threw = null;
  try {
    exported.apply(ctx);
  } catch (e) {
    threw = e;
  }
  eq(threw, null, 'B13 重复 apply 不抛错');
  ok(disposed.length >= 2, 'B14 重复 apply 前 dispose 了上一代注册', disposed);
  ok(registrations.length > firstCount, 'B15 新一代重新注册了组件', registrations.length);
}

{
  // 单个槽位缺失不能让另一个也注册不上，更不能让 apply 抛错
  const { ctx, registrations } = makeCtx({ injectThrowsOn: ['main'] });
  let threw = null;
  try {
    exported.apply(ctx);
  } catch (e) {
    threw = e;
  }
  eq(threw, null, 'B16 main 槽位缺失时 apply 不抛错');
  eq(registrations.length, 1, 'B17 侧边栏仍然注册成功');
  eq(registrations[0].options.name, 'sidebar.panellist', 'B18 剩下的是侧边栏入口');
}

{
  let threw = null;
  try {
    exported.apply({});
  } catch (e) {
    threw = e;
  }
  eq(threw, null, 'B19 没有 slots 服务时 apply 不抛错');
  try {
    exported.apply(null);
  } catch (e) {
    threw = e;
  }
  eq(threw, null, 'B20 ctx 为空时 apply 不抛错');
}

/* ================================================================== 数据准备 */

const indexPath = path.join(DSH_HOME, 'session-file-vault', 'index.json');
if (!existsSync(indexPath)) {
  console.error('真实索引不存在：' + indexPath + '\n请先运行 npm run build-index');
  process.exit(2);
}

const { Vault } = await import(pathToFileURL(path.join(ROOT, 'lib', 'vault.js')).href);
const vault = new Vault({ dshHome: DSH_HOME });
const state = vault.state();
ok(state.ready === true, 'C0 真实索引可读');
ok(Array.isArray(state.records) && state.records.length > 100, 'C0b 索引记录数 > 100', state.records.length);

const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);

/* ================================================================== C. 筛选逻辑 */

const base = internals.selectRecords(state, {});
eq(base.rows.length, state.records.length, 'C1 无筛选时行数等于记录数');
ok(base.totalAll === state.records.length, 'C2 totalAll 正确');

{
  let sorted = true;
  for (let i = 1; i < base.rows.length; i += 1) {
    const prev = base.rows[i - 1].lastPresentedAt || 0;
    const cur = base.rows[i].lastPresentedAt || 0;
    if (prev < cur) {
      sorted = false;
      break;
    }
  }
  ok(sorted, 'C3 默认按最近交付时间倒序');
}

{
  const docs = internals.selectRecords(state, { type: 'doc' });
  ok(docs.rows.length > 0, 'C4 类型筛选有结果', docs.rows.length);
  ok(docs.rows.every((r) => r.tags.type === 'doc'), 'C5 类型筛选结果类型一致');
  ok(docs.rows.length < state.records.length, 'C6 类型筛选确实收窄了范围');
}

{
  const tags = base.allTags.slice(0, 2).map((t) => t.tag);
  const anded = internals.selectRecords(state, { tags });
  ok(anded.rows.length > 0, 'C7 单标签筛选有结果');
  ok(
    anded.rows.every((r) => tags.every((t) => (r.tags.content || []).indexOf(t) >= 0)),
    'C8 多标签是「须同时包含」语义',
  );
  ok(anded.rows.length <= internals.selectRecords(state, { tags: [tags[0]] }).rows.length, 'C9 加标签不会变多');
}

{
  const from = base.rows[0].tags.date;
  const ranged = internals.selectRecords(state, { from: from, to: from });
  ok(ranged.rows.length > 0, 'C10 单日区间有结果');
  ok(ranged.rows.every((r) => r.tags.date === from), 'C11 日期区间结果都在区间内');
}

{
  const sample = base.rows.find((r) => (r.descriptions || []).length > 0 && r.descriptions[0].length > 4);
  ok(Boolean(sample), 'C12 存在带描述的记录');
  if (sample) {
    const needle = sample.descriptions[0].slice(0, 4);
    const hit = internals.selectRecords(state, { text: needle });
    ok(hit.rows.some((r) => r.id === sample.id), 'C13 文本搜索命中模型描述');
    const upper = internals.selectRecords(state, { text: needle.toUpperCase() });
    ok(upper.rows.some((r) => r.id === sample.id), 'C14 文本搜索大小写不敏感');
  }
  const miss = internals.selectRecords(state, { text: '__绝不可能出现的搜索词__' });
  eq(miss.rows.length, 0, 'C15 搜不到时结果为空');
}

{
  const byName = internals.selectRecords(state, { sort: 'name' });
  let sorted = true;
  for (let i = 1; i < byName.rows.length; i += 1) {
    if (String(byName.rows[i - 1].name).localeCompare(String(byName.rows[i].name)) > 0) {
      sorted = false;
      break;
    }
  }
  ok(sorted, 'C16 按名称排序生效');

  const bySize = internals.selectRecords(state, { sort: 'size' });
  ok((bySize.rows[0].sizeBytes || 0) >= (bySize.rows[bySize.rows.length - 1].sizeBytes || 0), 'C17 按体积排序生效');

  const byCount = internals.selectRecords(state, { sort: 'count' });
  ok((byCount.rows[0].presentCount || 0) >= (byCount.rows[byCount.rows.length - 1].presentCount || 0), 'C18 按交付次数排序生效');
}

{
  const sum = Object.values(base.typeCounts).reduce((a, b) => a + b, 0);
  eq(sum, state.records.length, 'C19 类型计数总和等于记录数');
  let desc = true;
  for (let i = 1; i < base.allTags.length; i += 1) {
    if (base.allTags[i - 1].count < base.allTags[i].count) {
      desc = false;
      break;
    }
  }
  ok(desc, 'C20 标签按出现次数降序');
  eq(base.allTags.length, new Set(base.allTags.map((t) => t.tag)).size, 'C21 标签去重');
}

/* ================================================================== D. 视图渲染 */

function viewProps(over) {
  return Object.assign(
    {
      view: { loading: false, error: null, data: state },
      busy: '',
      notice: '',
      filter: { text: '', type: '', tags: [], from: '', to: '', sort: 'recent' },
      tagQuery: '',
      tagOpen: false,
      openId: '',
      details: {},
      nowMs: NOW,
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
      onToggleRow() {},
      onLoadDetail() {},
    },
    over || {},
  );
}

const P = internals.PanelView;

{
  const out = html(React.createElement(P, viewProps({ view: { loading: true, error: null, data: null } })));
  includes(out, '正在加载文件索引', 'D1 渲染加载态');
}

{
  const out = html(React.createElement(P, viewProps({ view: { loading: false, error: '连接被拒绝', data: null } })));
  includes(out, '加载失败', 'D2 渲染错误态标题');
  includes(out, '连接被拒绝', 'D3 渲染错误详情');
  includes(out, '重试', 'D4 错误态有重试按钮');
}

{
  const out = html(
    React.createElement(
      P,
      viewProps({ view: { loading: false, error: null, data: { ready: false, rebuilding: false, records: [], meta: null } } }),
    ),
  );
  includes(out, '还没有索引', 'D5 渲染无索引态');
  includes(out, '重建索引', 'D6 无索引态引导重建');
}

{
  const out = html(
    React.createElement(
      P,
      viewProps({
        view: {
          loading: false,
          error: null,
          data: { ready: false, rebuilding: true, records: [], meta: null, progress: { phase: 'scan', scanned: 50, total: 200 } },
        },
      }),
    ),
  );
  includes(out, '正在建立文件索引', 'D7 渲染重建进度文案');
  includes(out, '已扫描 50 / 200', 'D8 渲染扫描进度数字');
  includes(out, 'width:25%', 'D9 进度条宽度按比例');
}

{
  const out = html(React.createElement(P, viewProps({ filter: { text: '__无结果__', tags: [], from: '', to: '', sort: 'recent' } })));
  includes(out, '没有匹配的文件', 'D10 渲染筛选空态');
  includes(out, '清空筛选', 'D11 空态提供清空筛选');
}

{
  const out = html(React.createElement(P, viewProps()));
  includes(out, '文件库', 'D12 渲染标题');
  includes(out, String(state.records.length) + ' 个文件', 'D13 渲染记录总数');
  includes(out, '在盘', 'D14 渲染在盘计数');
  const rows = (out.match(/class="sfv-row"/g) || []).length + (out.match(/class="sfv-row sfv-open"/g) || []).length;
  eq(rows, state.records.length, 'D15 渲染了全部行');
  const first = base.rows[0];
  includes(out, escapeHtml(first.name), 'D16 行里含文件名');
  includes(out, '全部', 'D17 类型 chips 有「全部」');
  includes(out, '添加内容标签', 'D18 有标签选择输入框');
  includes(out, '搜索文件名', 'D19 有搜索框');
}

{
  // 缺失文件标记
  const missing = state.records.find((r) => r.exists === false);
  ok(Boolean(missing), 'D20 存在已缺失的记录');
  if (missing) {
    const out = html(
      React.createElement(
        P,
        viewProps({ filter: { text: missing.name, tags: [], from: '', to: '', sort: 'recent' } }),
      ),
    );
    includes(out, '文件已不在磁盘', 'D21 缺失文件有角标');
    includes(out, 'sfv-name sfv-gone', 'D22 缺失文件名加删除线类');
  }
}

{
  // 展开详情
  const rec = base.rows[0];
  const detail = {
    id: rec.id,
    path: rec.path,
    name: rec.name,
    ext: rec.ext,
    sizeBytes: 12345,
    exists: true,
    presentCount: 3,
    firstPresentedAt: NOW - 86400000 * 5,
    lastPresentedAt: NOW,
    descriptions: ['一份用于验证的描述文本'],
    sessions: [
      { sessionId: 's1', title: '某个会话标题', projectLabel: '项目A', cwd: 'C:\\work', time: NOW - 1000 },
    ],
    tags: rec.tags,
  };
  const out = html(
    React.createElement(
      P,
      viewProps({
        filter: { text: rec.name, tags: [], from: '', to: '', sort: 'recent' },
        openId: rec.id,
        details: { [rec.id]: { loading: false, data: detail, error: null } },
      }),
    ),
  );
  includes(out, 'sfv-detail', 'D23 展开后渲染详情块');
  includes(out, '一份用于验证的描述文本', 'D24 详情含模型描述');
  includes(out, '某个会话标题', 'D25 详情含会话标题');
  includes(out, internals.fmtSize(12345), 'D26 详情格式化体积');
  ok(internals.fmtSize(12345) === '12.1 KB', 'D26b 12345 字节按 10~100 段保留一位小数');
  includes(out, '交付时模型的描述', 'D27 详情有描述分区');
  includes(out, '出现过的会话', 'D28 详情有会话分区');
}

{
  // 详情区挂在行下面，openId 必须命中真实记录 id 才会渲染
  const row = base.rows[0];
  const out = html(
    React.createElement(
      P,
      viewProps({ openId: row.id, details: { [row.id]: { loading: true, data: null, error: null } } }),
    ),
  );
  includes(out, '加载中…', 'D29 详情加载态');
}

{
  const row = base.rows[0];
  const out = html(
    React.createElement(
      P,
      viewProps({ openId: row.id, details: { [row.id]: { loading: false, data: null, error: '接口 500' } } }),
    ),
  );
  includes(out, '详情加载失败', 'D30 详情错误态');
  includes(out, '接口 500', 'D31 详情错误文案');
}

{
  const tag = base.allTags[0].tag;
  const out = html(
    React.createElement(P, viewProps({ filter: { text: '', type: '', tags: [tag], from: '', to: '', sort: 'recent' } })),
  );
  includes(out, 'sfv-selchip', 'D32 已选标签渲染成 chip');
  includes(out, '清空筛选', 'D33 有筛选时按钮文案切换');
}

{
  const out = html(React.createElement(P, viewProps({ busy: 'reload', view: { loading: false, error: null, data: state } })));
  includes(out, '读取中…', 'D34 刷新中按钮文案');
}

{
  const out = html(
    React.createElement(P, viewProps({ notice: '已开始重建索引，完成后列表会自动更新。' })),
  );
  includes(out, '已开始重建索引', 'D35 提示条渲染');
}

{
  const typeKey = Object.keys(base.typeCounts)[0];
  const out = html(React.createElement(P, viewProps()));
  const label = base.typeLabels[typeKey] || typeKey;
  includes(out, label, 'D36 类型 chip 显示中文标签');
}

/* ================================================================== E. 事件真调用 */

function fire(element, matcher, label, expect) {
  const nodes = findAll(element, (node) => matcher(node, node.props || {}));
  if (nodes.length === 0) {
    ok(false, label + '（没找到目标元素）');
    return null;
  }
  const node = nodes[0];
  const props = node.props || {};
  const handlerName = ['onClick', 'onMouseDown', 'onChange', 'onKeyDown'].find((k) => typeof props[k] === 'function');
  if (!handlerName) {
    ok(false, label + '（目标元素没有事件处理器）');
    return null;
  }
  const args = expect && expect.args ? expect.args : [{ preventDefault() {}, stopPropagation() {} }];
  const result = props[handlerName](...args);
  ok(true, label);
  return result;
}

{
  // 点类型 chip → onChange(cat.key)；再点一次 → onChange('')
  const calls = [];
  const el = React.createElement(P, viewProps({ onType: (v) => calls.push(v) }));
  const first = Object.keys(base.typeCounts)[0];
  fire(el, (n) => hasClass(n, 'sfv-chip') && textOf(n).indexOf(base.typeLabels[first]) >= 0, 'E1 找到类型 chip 并点击');
  eq(calls[calls.length - 1], first, 'E2 点类型 chip 传出该类型 key');

  const calls2 = [];
  const el2 = React.createElement(
    P,
    viewProps({ filter: { text: '', type: first, tags: [], from: '', to: '', sort: 'recent' }, onType: (v) => calls2.push(v) }),
  );
  fire(el2, (n) => hasClass(n, 'sfv-chip') && textOf(n).indexOf(base.typeLabels[first]) >= 0, 'E3 点击已选中的类型 chip');
  eq(calls2[calls2.length - 1], '', 'E4 再点已选类型取消筛选');

  const callsAll = [];
  const elAll = React.createElement(P, viewProps({ onType: (v) => callsAll.push(v) }));
  fire(elAll, (n) => hasClass(n, 'sfv-chip') && textOf(n).indexOf('全部') >= 0, 'E5 找到「全部」chip');
  eq(callsAll[0], '', 'E6 点「全部」清空类型筛选');
}

{
  // 标签浮层：点条目 → onToggle(tag)
  const calls = [];
  const tag = base.allTags[0].tag;
  const el = React.createElement(
    P,
    viewProps({ tagOpen: true, onToggleTag: (t) => calls.push(t) }),
  );
  fire(el, (n) => hasClass(n, 'sfv-tagitem') && textOf(n).indexOf(tag) >= 0, 'E7 找到标签条目并点击', {
    args: [{ preventDefault() {} }],
  });
  eq(calls[calls.length - 1], tag, 'E8 点标签条目传出标签名');

  // 已选 chip 再点 → 移除
  const calls2 = [];
  const el2 = React.createElement(
    P,
    viewProps({ filter: { text: '', type: '', tags: [tag], from: '', to: '', sort: 'recent' }, onToggleTag: (t) => calls2.push(t) }),
  );
  fire(el2, (n) => hasClass(n, 'sfv-selchip'), 'E9 找到已选标签 chip 并点击', { args: [{}] });
  eq(calls2[calls2.length - 1], tag, 'E10 点已选标签传出标签名（由外层取反）');
}

{
  // 点行 → onToggle(rec.id)
  const calls = [];
  const el = React.createElement(P, viewProps({ onToggleRow: (id) => calls.push(id) }));
  fire(el, (n) => hasClass(n, 'sfv-row'), 'E11 找到列表行并点击', { args: [{}] });
  eq(calls.length, 1, 'E12 点行触发了 toggle');
  eq(calls[0], base.rows[0].id, 'E13 传出的是首行记录的 id');
}

{
  // 搜索框 → onText
  const calls = [];
  const el = React.createElement(P, viewProps({ onText: (v) => calls.push(v) }));
  fire(el, (n) => n.type === 'input' && (n.props || {}).type === 'search', 'E14 找到搜索框并输入', {
    args: [{ target: { value: '报告' } }],
  });
  eq(calls[calls.length - 1], '报告', 'E15 搜索框传出输入内容');
}

{
  // 清空筛选 / 重建索引 / 刷新
  const calls = [];
  const el = React.createElement(
    P,
    viewProps({
      filter: { text: 'x', type: '', tags: [], from: '', to: '', sort: 'recent' },
      onClear: () => calls.push('clear'),
      onRebuild: () => calls.push('rebuild'),
      onReload: () => calls.push('reload'),
    }),
  );
  fire(el, (n) => hasClass(n, 'sfv-btn') && textOf(n) === '清空筛选', 'E16 找到清空筛选按钮');
  fire(el, (n) => hasClass(n, 'sfv-btn') && textOf(n).indexOf('重建索引') >= 0, 'E17 找到重建索引按钮');
  fire(el, (n) => hasClass(n, 'sfv-btn') && textOf(n) === '刷新', 'E18 找到刷新按钮');
  eq(calls.join(','), 'clear,rebuild,reload', 'E19 三个按钮各自调到对的回调');
}

{
  // 排序下拉 → onSort
  const calls = [];
  const el = React.createElement(P, viewProps({ onSort: (v) => calls.push(v) }));
  const selects = findAll(el, (n) => n.type === 'select');
  if (selects.length > 0) {
    selects[0].props.onChange({ target: { value: 'size' } });
    eq(calls[calls.length - 1], 'size', 'E20 排序下拉传出新排序方式');
  } else {
    ok(false, 'E20 找不到排序下拉');
  }
}

{
  // 日期区间 → onFrom / onTo
  const calls = [];
  const el = React.createElement(P, viewProps({ onFrom: (v) => calls.push('from:' + v), onTo: (v) => calls.push('to:' + v) }));
  const dates = findAll(el, (n) => n.type === 'input' && (n.props || {}).type === 'date');
  eq(dates.length, 2, 'E21 有两个日期输入框');
  if (dates.length === 2) {
    dates[0].props.onChange({ target: { value: '2026-10-01' } });
    dates[1].props.onChange({ target: { value: '2026-10-30' } });
    eq(calls.join(','), 'from:2026-10-01,to:2026-10-30', 'E22 日期框分别传出起止值');
  }
}

/* ================================================================== F. 工具函数 */

eq(internals.fmtSize(0), '0 B', 'F1 fmtSize 0');
eq(internals.fmtSize(1024), '1.00 KB', 'F2 fmtSize 1KB');
eq(internals.fmtSize(1536), '1.50 KB', 'F3 fmtSize 1.5KB');
ok(internals.fmtSize(null) === '—', 'F4 fmtSize 非数字给占位符');
eq(internals.ymdOf(Date.UTC(2026, 9, 30, 4, 0, 0) + 4 * 3600 * 1000), '2026-10-30', 'F5 ymdOf 用本地日期');
eq(internals.relOf(NOW - 5000, NOW), '刚刚', 'F6 relOf 刚刚');
eq(internals.relOf(NOW - 3600 * 1000, NOW), '1 小时前', 'F7 relOf 小时');
eq(internals.relOf(NOW - 86400000 * 3, NOW), '3 天前', 'F8 relOf 天');
ok(internals.shortDir('C:\\a\\b\\c\\d').indexOf('…') === 0, 'F9 shortDir 缩写前缀');
eq(internals.shortDir('C:\\a'), 'C:\\a', 'F10 shortDir 短路径原样');

/* ================================================================== G. 图标 */

{
  const el = internals.SidebarIcon({ size: 18, active: true });
  ok(el && el.type === 'svg', 'G1 侧边栏图标是 svg');
  eq(el.props.width, 18, 'G2 图标尺寸透传');
  ok(Array.isArray(el.props.children) && el.props.children.length >= 4, 'G3 图标有多个 path');
  const inactive = internals.SidebarIcon({ size: 20, active: false });
  eq(inactive.props.width, 20, 'G4 图标无 props 时也能渲染');
  ok(internals.SidebarIcon().props.width > 0, 'G5 图标默认尺寸有效');
}

/* ------------------------------------------------------------------ 输出 */

function escapeHtml(s) {
  return String(s == null ? '' : s);
}

const total = passed + failures.length;
console.log('');
console.log('客户端半边离线验证：' + passed + '/' + total + ' 通过');
if (failures.length > 0) {
  console.log('');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');
process.exit(0);

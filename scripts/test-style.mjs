#!/usr/bin/env node
/**
 * 样式注入（ensureStyle）离线验证。
 *
 * 为什么单独一个文件：渲染类断言只检查「有没有 style 标签」，查不出
 * 「标签存在但 textContent 是 0 字节」——本插件真实犯过这个毛病（页面裸样式）。
 * 这里给它一个最小假 DOM，直接调 ensureStyle，把四种真实场景钉住：
 *   1 全新页面         → 创建 1 个标签，内容等于 CSS
 *   2 重复调用         → 不重复插入
 *   3 已存在空标签     → 必须补写内容（当初的 bug）
 *   4 残留重复标签     → 收敛成 1 个
 *   5 没有 document    → 静默返回，不抛错（SSR / 测试环境）
 *
 * 用法：node scripts/test-style.mjs
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
try {
  React = req('react');
} catch (e) {
  console.error('无法从 ' + SCRATCH + ' 加载 react：' + e.message);
  console.error('请先在该目录 npm i react@18 react-dom@18');
  process.exit(2);
}

const source = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

/* ---------------------------------------------------------------- 断言 */

let passed = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) {
    passed += 1;
  } else {
    failures.push(label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
  }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, { actual, expected });
}

/* ------------------------------------------------------------ 最小假 DOM */

/**
 * @param {Array} seed 预先存在的节点（会被当作已在 head 里）
 */
function makeDom(seed) {
  let nodes = [];

  const head = {
    childNodes: nodes,
    appendChild(node) {
      nodes.push(node);
      node.parentNode = head;
      return node;
    },
    removeChild(node) {
      const i = nodes.indexOf(node);
      if (i >= 0) nodes.splice(i, 1);
      node.parentNode = null;
      return node;
    },
  };

  const doc = {
    head,
    documentElement: head,
    createElement(tag) {
      return { tagName: String(tag).toUpperCase(), id: '', textContent: '', parentNode: null };
    },
    getElementById(id) {
      return nodes.find((n) => n.id === id) || null;
    },
    querySelectorAll(selector) {
      const m = /^style\[id="(.+)"\]$/.exec(String(selector));
      if (!m) return [];
      return nodes.filter((n) => n.tagName === 'STYLE' && n.id === m[1]);
    },
    nodes: () => nodes,
  };

  for (const s of seed || []) {
    nodes.push(s);
    s.parentNode = head;
  }
  return doc;
}

/* ------------------------------------------------------------- 加载 bundle */

function load(doc) {
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
    document: doc === null ? undefined : doc,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
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

  const exported = captured.factory((id) => {
    if (id === 'react') return React;
    throw new Error('offline-test: 未知模块 ' + id);
  });
  const internals = sandboxWindow.__SFV_INTERNALS__;
  if (!internals) throw new Error('测试钩子未挂载（window.__SFV_INTERNALS__ 缺失）');
  return { exported, internals };
}

/* ------------------------------------------------------------------ 用例 */

const first = load(makeDom());
const CSS = first.internals.CSS;
const STYLE_ID = first.internals.constants.STYLE_ID;

ok(typeof CSS === 'string' && CSS.length > 6000, 'CSS 字面量非空且体积合理', { len: CSS.length });
ok(CSS.indexOf('</style>') === -1, 'CSS 里不含 </style>（否则提前闭合标签）');
ok(/\$\{/.test(CSS) === false, 'CSS 里没有残留模板插值');
ok(/\.sfv-root/.test(CSS), 'CSS 含 .sfv-root');
ok(/\.sfv-detail/.test(CSS), 'CSS 含 .sfv-detail');
ok(/\.sfv-chip/.test(CSS), 'CSS 含 .sfv-chip');

/* 1 全新页面 */
{
  const doc = makeDom();
  const { internals } = load(doc);
  internals.ensureStyle();
  const nodes = doc.nodes();
  eq(nodes.length, 1, '1-全新页面：只插入 1 个 style 标签');
  eq(nodes[0] && nodes[0].id, STYLE_ID, '1-全新页面：标签 id 正确');
  eq(nodes[0] && nodes[0].textContent, CSS, '1-全新页面：标签内容等于 CSS（不是 0 字节）');
  ok(nodes[0] && nodes[0].textContent.length > 6000, '1-全新页面：样式表长度合理', {
    len: nodes[0] ? nodes[0].textContent.length : -1,
  });
  ok(nodes[0] && nodes[0].parentNode === doc.head, '1-全新页面：挂在 head 上');
}

/* 2 重复调用（HMR 重跑 apply） */
{
  const doc = makeDom();
  const { internals } = load(doc);
  internals.ensureStyle();
  internals.ensureStyle();
  internals.ensureStyle();
  eq(doc.nodes().length, 1, '2-重复调用：不重复插入标签');
  eq(doc.nodes()[0].textContent, CSS, '2-重复调用：内容保持 CSS');
}

/* 3 已存在空标签（当初真实踩到的 bug） */
{
  const doc = makeDom([{ tagName: 'STYLE', id: STYLE_ID, textContent: '', parentNode: null }]);
  const { internals } = load(doc);
  internals.ensureStyle();
  eq(doc.nodes().length, 1, '3-已有空标签：不额外插入');
  eq(doc.nodes()[0].textContent, CSS, '3-已有空标签：补写内容（关键回归断言）');
}

/* 3b 已存在内容过期（CSS 改过但 HMR 没换标签） */
{
  const doc = makeDom([{ tagName: 'STYLE', id: STYLE_ID, textContent: '.sfv-root{}', parentNode: null }]);
  const { internals } = load(doc);
  internals.ensureStyle();
  eq(doc.nodes()[0].textContent, CSS, '3b-内容过期：整份替换为最新 CSS');
}

/* 4 残留重复标签（历史遗留 / 并发注入） */
{
  const doc = makeDom([
    { tagName: 'STYLE', id: STYLE_ID, textContent: CSS, parentNode: null },
    { tagName: 'STYLE', id: STYLE_ID, textContent: CSS, parentNode: null },
    { tagName: 'STYLE', id: STYLE_ID, textContent: CSS, parentNode: null },
  ]);
  const { internals } = load(doc);
  internals.ensureStyle();
  eq(doc.nodes().length, 1, '4-重复标签：收敛为 1 个');
  eq(doc.nodes()[0].textContent, CSS, '4-重复标签：保留的那份内容正确');
}

/* 4b 无关标签不能被误删 */
{
  const doc = makeDom([
    { tagName: 'STYLE', id: 'other-style', textContent: 'body{}', parentNode: null },
    { tagName: 'STYLE', id: STYLE_ID, textContent: '', parentNode: null },
  ]);
  const { internals } = load(doc);
  internals.ensureStyle();
  eq(doc.nodes().length, 2, '4b-无关标签：保留别的 style 标签');
  ok(
    doc.nodes().some((n) => n.id === 'other-style'),
    '4b-无关标签：other-style 仍在',
  );
}

/* 5 没有 document（SSR / 纯 node 环境） */
{
  const { internals } = load(null);
  let threw = null;
  try {
    internals.ensureStyle();
  } catch (e) {
    threw = e;
  }
  eq(threw, null, '5-无 document：静默返回不抛错');
}

/* 6 常量自洽 */
{
  const { internals } = first;
  eq(internals.constants.STYLE_ID, 'dsh-session-file-vault-style', '6-STYLE_ID 与宿主约定一致');
  eq(internals.constants.PANEL_ID, internals.constants.PANEL_ID, '6-PANEL_ID 存在');
  ok(typeof internals.constants.PANEL_ID === 'string' && internals.constants.PANEL_ID.length > 0, '6-PANEL_ID 非空');
  ok(typeof internals.constants.SIDEBAR_ORDER === 'number', '6-SIDEBAR_ORDER 是数字');
  ok(Array.isArray(internals.constants.TYPE_ICON) || typeof internals.constants.TYPE_ICON === 'object', '6-TYPE_ICON 可用');
}

/* ------------------------------------------------------------------ 汇总 */

const total = passed + failures.length;
if (failures.length) {
  console.error('\n样式注入验证：' + passed + ' 通过，' + failures.length + ' 失败（共 ' + total + ' 项）');
  for (const f of failures) console.error('  ✗ ' + f);
  process.exitCode = 1;
} else {
  console.log('\n样式注入验证：' + passed + ' 通过，0 失败（共 ' + total + ' 项）');
}

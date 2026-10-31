#!/usr/bin/env node
/**
 * 脑图（M3）离线验证：布局纯函数 buildGraph + 渲染 GraphView / PanelView 切换。
 *
 * 为什么要单独一个文件：脑图最容易出的错不是「画不出来」，而是「画错了但不报错」——
 * 同一个文件被画两次、节点坐标算出 NaN、维度按字母序而非数量排、空数据整块白屏。
 * 这些都能在 Node 里用确定性的几何断言钉住，不必每次都起浏览器。
 *
 * 用法：node scripts/test-graph.mjs
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
let renderToStaticMarkup;
try {
  React = req('react');
  renderToStaticMarkup = req('react-dom/server').renderToStaticMarkup;
} catch (e) {
  console.error('无法从 ' + SCRATCH + ' 加载 react / react-dom：' + e.message);
  console.error('请先在该目录 npm i react@18 react-dom@18');
  process.exit(2);
}

const source = readFileSync(path.join(ROOT, 'lib', 'client.js'), 'utf8');

/* ---------------------------------------------------------------- 断言 */

let passed = 0;
const failures = [];

function ok(cond, label, detail) {
  if (cond) passed += 1;
  else failures.push(label + (detail === undefined ? '' : '  → ' + JSON.stringify(detail)));
}
function eq(actual, expected, label) {
  ok(actual === expected, label, { actual, expected });
}

/* ------------------------------------------------------------- 加载 bundle */

function load() {
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
    if (id === 'react/jsx-runtime') return req('react/jsx-runtime');
    throw new Error('offline-test: 未知模块 ' + id);
  });
  const internals = sandboxWindow.__SFV_INTERNALS__;
  if (!internals) throw new Error('测试钩子未挂载（window.__SFV_INTERNALS__ 缺失）');
  return { exported, internals };
}

const { internals } = load();
const { buildGraph, GraphView, PanelView, selectRecords, constants } = internals;

/* ------------------------------------------------------------ 测试数据 */

const TYPE_CATS = [
  { key: 'doc', label: '文档', order: 10 },
  { key: 'image', label: '图片', order: 20 },
  { key: 'web', label: '网页', order: 30 },
];
const TYPE_LABELS = { doc: '文档', image: '图片', web: '网页' };

function rec(id, name, type, tags, extra) {
  const r = {
    id: id,
    name: name,
    path: 'D:\\dsh-work\\demo\\' + name,
    dir: 'D:\\dsh-work\\demo',
    ext: '.md',
    sizeBytes: 1024,
    exists: true,
    firstPresentedAt: 1000,
    lastPresentedAt: 1000,
    presentCount: 1,
    descriptions: ['演示用描述'],
    tags: { type: type, content: tags, date: '2026-10-30' },
  };
  Object.assign(r, extra || {});
  return r;
}

const RECORDS = [
  rec('r1', 'a.md', 'doc', ['发票', '清单'], { lastPresentedAt: 900, presentCount: 6 }),
  rec('r2', 'b.md', 'doc', ['发票'], { lastPresentedAt: 800, presentCount: 1 }),
  rec('r3', 'c.png', 'image', ['截图', '清单'], { lastPresentedAt: 700, presentCount: 2, exists: false }),
  rec('r4', 'd.html', 'web', [], { lastPresentedAt: 600, presentCount: 1 }),
];

const DATA = {
  ready: true,
  rebuilding: false,
  records: RECORDS,
  meta: {
    total: 4,
    existsCount: 3,
    missingCount: 1,
    generatedAt: 1790000000000,
    typeCategories: TYPE_CATS,
    stats: {},
  },
};

const BASE_PROPS = {
  view: { loading: false, error: null, data: DATA },
  busy: '',
  notice: '',
  filter: { text: '', type: '', tags: [], from: '', to: '', sort: 'recent' },
  tagQuery: '',
  tagOpen: false,
  openId: '',
  details: {},
  mode: 'list',
  graphDim: 'tag',
};

/* ---------------------------------------------------------- 1 常量与基本形 */

eq(constants.GRAPH_SIZE, 1240, '常量：GRAPH_SIZE = 1240');
eq(typeof constants.GRAPH_TAG_NONE, 'string', '常量：GRAPH_TAG_NONE 是字符串');

const empty = buildGraph([], 'tag', TYPE_LABELS);
eq(empty.total, 0, '空输入：total = 0');
eq(empty.dims.length, 0, '空输入：没有维度节点');
eq(empty.files.length, 0, '空输入：没有文件节点');
eq(empty.edges.length, 0, '空输入：没有连线');
eq(empty.w, 1240, '空输入：画布宽度');
eq(empty.h, 1240, '空输入：画布高度');
ok(buildGraph(null, 'tag', null).total === 0, '空输入（null）：不抛错');

/* -------------------------------------------------- 2 标签维度的节点与计数 */

const gTag = buildGraph(RECORDS, 'tag', TYPE_LABELS);
eq(gTag.total, 4, '标签模式：total = 4');
eq(gTag.dimCount, 4, '标签模式：维度数 = 4（发票/清单/截图/未打标签）');
eq(gTag.files.length, 4, '标签模式：每个文件恰好一个节点');
eq(gTag.edges.length, 6, '标签模式：连线数 = 各记录标签数之和');

const ids = gTag.files.map((f) => f.id);
eq(new Set(ids).size, 4, '标签模式：文件节点 id 不重复（没有重复绘制）');

const dimKeys = gTag.dims.map((d) => d.key);
ok(dimKeys.indexOf('发票') >= 0 && dimKeys.indexOf('清单') >= 0, '标签模式：包含 发票 / 清单', dimKeys);
ok(dimKeys.indexOf(constants.GRAPH_TAG_NONE) >= 0, '标签模式：无标签文件归入伪维度', dimKeys);

const noneDim = gTag.dims.filter((d) => d.key === constants.GRAPH_TAG_NONE)[0];
eq(noneDim && noneDim.label, '未打标签', '标签模式：伪维度显示名 = 未打标签');
eq(noneDim && noneDim.count, 1, '标签模式：伪维度计数 = 1');

// 维度必须按数量降序（发票 2 / 清单 2 / 截图 1 / 未打标签 1）
let sortedOk = true;
for (let i = 1; i < gTag.dims.length; i += 1) {
  if (gTag.dims[i - 1].count < gTag.dims[i].count) sortedOk = false;
}
ok(sortedOk, '标签模式：维度按文件数降序排列', gTag.dims.map((d) => d.count));

// 每个文件只归一个主维度
const ownTotal = gTag.dims.reduce((s, d) => s + d.own, 0);
eq(ownTotal, 4, '标签模式：主维度认领总数 = 文件总数（每个文件只画一次）');

/* ------------------------------------------------------ 3 类型维度的映射 */

const gType = buildGraph(RECORDS, 'type', TYPE_LABELS);
eq(gType.dimCount, 3, '类型模式：维度数 = 3');
eq(gType.edges.length, 4, '类型模式：连线数 = 4（每记录一个类型）');
const docDim = gType.dims.filter((d) => d.key === 'doc')[0];
eq(docDim && docDim.label, '文档', '类型模式：维度名用中文标签');
eq(docDim && docDim.count, 2, '类型模式：文档计数 = 2');
const webDim = gType.dims.filter((d) => d.key === 'web')[0];
eq(webDim && webDim.label, '网页', '类型模式：网页计数维度存在');

const gNoType = buildGraph([rec('x1', 'x.md', '', [])], 'type', TYPE_LABELS);
eq(gNoType.dims[0] && gNoType.dims[0].label, '未分类', '类型模式：无类型文件显示「未分类」');

/* ------------------------------------------------------------- 4 几何性质 */

const inCanvas = gTag.files.every(
  (f) => isFinite(f.x) && isFinite(f.y) && f.x >= 0 && f.x <= 1240 && f.y >= 0 && f.y <= 1240,
);
ok(inCanvas, '几何：所有文件节点坐标有限且在 1240×1240 画布内');

const dimRadOk = gTag.dims.every((d) => d.r >= 10 && d.r <= 26);
ok(dimRadOk, '几何：维度半径落在 [10, 26]');
const fileRadOk = gTag.files.every((f) => f.r >= 2.2 && f.r <= 9);
ok(fileRadOk, '几何：文件半径落在 [2.2, 9]');

const dimDistOk = gTag.dims.every((d) => {
  const dist = Math.sqrt((d.x - gTag.cx) * (d.x - gTag.cx) + (d.y - gTag.cy) * (d.y - gTag.cy));
  return Math.abs(dist - 250) < 0.01;
});
ok(dimDistOk, '几何：宽松分布下维度节点都落在半径 250 的主轨道上');

// 长尾标签挤在窄扇形里时必须交替到内轨，否则圆与标签会叠成一坨
{
  const denseRows = [];
  for (let i = 0; i < 40; i += 1) {
    denseRows.push({
      id: 'dense' + i,
      path: '/x/dense' + i + '.md',
      name: 'dense' + i + '.md',
      ext: '.md',
      exists: true,
      lastPresentedAt: 1790000000000 + i,
      presentCount: 1,
      tags: { type: 'doc', content: ['tag' + i] },
    });
  }
  const gDense = buildGraph(denseRows, 'tag', TYPE_LABELS);
  const radii = Array.from(new Set(gDense.dims.map((d) => Math.round(Math.hypot(d.x - gDense.cx, d.y - gDense.cy))))).sort();
  ok(gDense.dimCount === 40, '密集维度：40 个标签维度全部建出', gDense.dimCount);
  ok(radii.indexOf(250) >= 0 && radii.indexOf(188) >= 0, '密集维度：相邻过密的维度交替到内轨', radii);
  ok(
    radii.every((r) => r === 250 || r === 188),
    '密集维度：只使用内外两条轨道',
    radii,
  );
  const denseOk = gDense.dims.every(
    (d) => isFinite(d.x) && isFinite(d.y) && d.x >= 0 && d.x <= 1240 && d.y >= 0 && d.y <= 1240,
  );
  ok(denseOk, '密集维度：交替后坐标仍在画布内');
  // 确定性：同样输入两次结果一致
  const again = buildGraph(denseRows, 'tag', TYPE_LABELS);
  const stable = JSON.stringify(again.dims.map((d) => [d.key, Math.round(d.x * 1000), Math.round(d.y * 1000)])) ===
    JSON.stringify(gDense.dims.map((d) => [d.key, Math.round(d.x * 1000), Math.round(d.y * 1000)]));
  ok(stable, '密集维度：布局是确定性的');
}

const fileDistOk = gTag.files.every((f) => {
  const dist = Math.sqrt((f.x - gTag.cx) * (f.x - gTag.cx) + (f.y - gTag.cy) * (f.y - gTag.cy));
  return dist >= 559 && dist <= 597;
});
ok(fileDistOk, '几何：文件节点落在半径 560 / 596 的交替轨道上');

// 同一主维度内的文件必须交替落在 560 / 596 两条轨道上（小角度下靠这个防止互相压盖）
{
  let cursor = 0;
  let altChecked = 0;
  let altOk = true;
  for (const d of gTag.dims) {
    const slice = gTag.files.slice(cursor, cursor + d.own);
    cursor += d.own;
    for (let k = 0; k < slice.length; k += 1) {
      const dist = Math.hypot(slice[k].x - gTag.cx, slice[k].y - gTag.cy);
      const want = k % 2 === 0 ? 560 : 596;
      if (Math.abs(dist - want) > 0.01) altOk = false;
      altChecked += 1;
    }
  }
  ok(altChecked === 4 && altOk, '几何：同组文件交替使用内外两条轨道', { altChecked, altOk });
}

const firstEdge = gTag.edges[0];
const edgeDim = gTag.dims.filter((d) => d.key === firstEdge.from)[0];
const edgeFile = gTag.files.filter((f) => f.id === firstEdge.to)[0];
ok(
  firstEdge && edgeDim && edgeFile && firstEdge.x1 === edgeDim.x && firstEdge.x2 === edgeFile.x,
  '几何：连线端点与节点坐标一致',
);

/* --------------------------------------------------------- 5 确定性 / 缺失 */

const again = buildGraph(RECORDS, 'tag', TYPE_LABELS);
let deterministic = again.dims.length === gTag.dims.length;
for (let i = 0; i < again.dims.length && deterministic; i += 1) {
  if (again.dims[i].x !== gTag.dims[i].x || again.dims[i].y !== gTag.dims[i].y) deterministic = false;
}
ok(deterministic, '确定性：同样输入两次得到同样坐标（可离线复现）');

const missNode = gTag.files.filter((f) => f.id === 'r3')[0];
eq(missNode && missNode.exists, false, '文件状态：缺失文件 exists = false 传到节点');
eq(missNode && missNode.count, 2, '文件状态：presentCount 传到节点');

/* --------------------------------------------------------- 6 GraphView 渲染 */

function renderGraph(graph, extra) {
  return renderToStaticMarkup(
    React.createElement(GraphView, Object.assign({ graph: graph }, extra || {})),
  );
}

const emptyHtml = renderGraph(buildGraph([], 'tag', TYPE_LABELS));
ok(emptyHtml.indexOf('sfv-graph-empty') >= 0, '渲染：空图显示占位文案容器');
ok(emptyHtml.indexOf('暂无可绘制') >= 0, '渲染：空图占位文案可读');
ok(emptyHtml.indexOf('<svg') < 0, '渲染：空图不输出 svg');

const gHtml = renderGraph(gTag);
ok(gHtml.indexOf('<svg') >= 0, '渲染：有数据时输出 svg');
ok(gHtml.indexOf('class="sfv-graph"') >= 0, '渲染：svg 带 sfv-graph 类');
ok(gHtml.indexOf('viewBox="0 0 1240 1240"') >= 0, '渲染：viewBox 为 1240×1240');

const countOf = (html, re) => (html.match(re) || []).length;
eq(countOf(gHtml, /<line class="sfv-gedge"/g), gTag.edges.length, '渲染：连线数量与 edges 一致');
eq(countOf(gHtml, /<g class="sfv-gdim/g), gTag.dims.length, '渲染：维度节点数量与 dims 一致');
eq(countOf(gHtml, /<g class="sfv-gfile/g), gTag.files.length, '渲染：文件节点数量与 files 一致');

ok(gHtml.indexOf('sfv-miss') >= 0, '渲染：失效文件带 sfv-miss 标记');
ok(gHtml.indexOf('点击按此筛选') >= 0, '渲染：维度节点 title 提示可筛选');
ok(gHtml.indexOf('点击查看详情') >= 0, '渲染：文件节点 title 提示可看详情');

const selHtml = renderGraph(gTag, { selectedDims: { 发票: true } });
ok(selHtml.indexOf('sfv-gdim sfv-sel') >= 0, '渲染：已选维度带 sfv-sel');

const litHtml = renderGraph(gTag);
// 「清单」2 个文件 < 8 → 不显示文字标签，但计数数字始终存在
ok(litHtml.indexOf('>发票<') < 0, '渲染：标签模式下小众维度不显示文字标签（避免糊成一团）');
eq(countOf(litHtml, /class="sfv-gdim-c"/g), gTag.dims.length, '渲染：每个维度都有计数数字');

/* ---------------------------------------------------- 7 PanelView 视图切换 */

const listHtml = renderToStaticMarkup(React.createElement(PanelView, Object.assign({}, BASE_PROPS)));
ok(listHtml.indexOf('sfv-list') >= 0, '列表模式：渲染 .sfv-list');
ok(listHtml.indexOf('sfv-graph-wrap') < 0, '列表模式：不渲染脑图');
ok(listHtml.indexOf('>列表<') >= 0 && listHtml.indexOf('>脑图<') >= 0, '列表模式：顶栏有 列表 / 脑图 切换按钮');

const graphHtml = renderToStaticMarkup(
  React.createElement(PanelView, Object.assign({}, BASE_PROPS, { mode: 'graph' })),
);
ok(graphHtml.indexOf('sfv-graph-wrap') >= 0, '脑图模式：渲染 .sfv-graph-wrap');
ok(graphHtml.indexOf('class="sfv-graph"') >= 0, '脑图模式：内部渲染 svg');
ok(graphHtml.indexOf('sfv-graphbar') >= 0, '脑图模式：渲染聚合工具条');
ok(graphHtml.indexOf('内容标签') >= 0 && graphHtml.indexOf('文件类型') >= 0, '脑图模式：两种聚合维度可切换');
ok(graphHtml.indexOf('聚合 · 4 组 / 4 个文件') >= 0, '脑图模式：工具条显示组数 / 文件数');
ok(graphHtml.indexOf('sfv-list') < 0, '脑图模式：不渲染列表');

const graphTypeHtml = renderToStaticMarkup(
  React.createElement(PanelView, Object.assign({}, BASE_PROPS, { mode: 'graph', graphDim: 'type' })),
);
ok(graphTypeHtml.indexOf('>文件类型<') >= 0, '脑图类型模式：按钮存在');
ok(graphTypeHtml.indexOf('聚合 · 3 组 / 4 个文件') >= 0, '脑图类型模式：组数按类型算 = 3');

// 筛选后脑图只画筛出来的文件
const selDoc = selectRecords(DATA, { type: 'doc' });
eq(selDoc.rows.length, 2, '筛选联动：type=doc 命中 2 条');
const gDoc = buildGraph(selDoc.rows, 'type', selDoc.typeLabels);
eq(gDoc.total, 2, '筛选联动：脑图只画 2 个文件');
eq(gDoc.dimCount, 1, '筛选联动：只剩 1 个类型维度');

const selTag = selectRecords(DATA, { tags: ['清单'] });
eq(selTag.rows.length, 2, '筛选联动：标签=清单 命中 2 条');
const gSelTag = buildGraph(selTag.rows, 'tag', selTag.typeLabels);
eq(gSelTag.total, 2, '筛选联动：脑图只画命中的 2 个文件');

/* ------------------------------------------- 8 视口：平移 / 滚轮缩放 */

const {
  clampGraphZoom,
  clampGraphView,
  zoomGraphView,
  panGraphView,
  graphScaleOf,
  screenToGraphPoint,
  graphTransformOf,
} = internals;
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol);

// 变换固定为 translate(x,y) scale(k)：屏幕坐标 s = x + k * 用户坐标。
// 这些纯函数是「拖不丢、缩不乱、点得准」的全部逻辑，DOM 侧只剩事件接线。

eq(constants.GRAPH_ZOOM_MIN, 0.45, '视口：最小缩放常量为 0.45');
eq(constants.GRAPH_ZOOM_MAX, 5, '视口：最大缩放常量为 5');
eq(clampGraphZoom(1), 1, '视口：缩放 1 保持 1');
eq(clampGraphZoom(0.1), 0.45, '视口：缩得过小时夹到下限');
eq(clampGraphZoom(99), 5, '视口：放得过大时夹到上限');
eq(clampGraphZoom(NaN), 1, '视口：NaN 缩放回落到 1（不产生 NaN 坐标）');
eq(clampGraphZoom(undefined), 1, '视口：缺省缩放回落到 1');

const keepView = clampGraphView({ k: 1, x: 5000, y: -5000 });
eq(keepView.x, 992, '视口：向右拖越界被夹到 0.8×1240');
eq(keepView.y, -992, '视口：向左拖越界被夹到 0.2×1240 − 1240');
eq(clampGraphView({ k: 2, x: 0, y: -99999 }).y, -2232, '视口：放大 2 倍后下边界随缩放放宽');
eq(clampGraphView(null).k, 1, '视口：空视口回落到 {k:1, x:0, y:0}');
eq(clampGraphView({ k: 1, x: 0, y: 0 }).x, 0, '视口：合法视口原样返回');

const z0 = { k: 1, x: 120, y: -80 };
const z1 = zoomGraphView(z0, 1.6, 500, 420);
ok(near(z1.k, 1.6), '视口：放大 1.6 倍后 k 变为 1.6', z1);
ok(near(z1.x, -108) && near(z1.y, -380), '视口：放大后 translate 按焦点重算', z1);
// 焦点用户坐标 u = (s - x) / k；缩放后必须满足 x' + k' * u === s
const ux = (500 - z0.x) / z0.k;
const uy = (420 - z0.y) / z0.k;
ok(near(z1.x + z1.k * ux, 500) && near(z1.y + z1.k * uy, 420), '视口：缩放前后焦点在屏幕上不动');
const z2 = zoomGraphView(z1, 1 / 1.6, 500, 420);
ok(near(z2.x, z0.x) && near(z2.y, z0.y) && near(z2.k, z0.k), '视口：放大再在同点缩小可精确还原', z2);
eq(zoomGraphView({ k: 5, x: 0, y: 0 }, 2, 620, 620).k, 5, '视口：已到上限时继续放大不再变化');
eq(zoomGraphView({ k: 0.45, x: 0, y: 0 }, 0.5, 620, 620).k, 0.45, '视口：已到下限时继续缩小不再变化');

const p1 = panGraphView({ k: 1, x: 0, y: 0 }, 60, -40);
ok(near(p1.x, 60) && near(p1.y, -40), '视口：平移量直接叠加到 translate', p1);
eq(panGraphView({ k: 1, x: 0, y: 0 }, 99999, 0).x, 992, '视口：平移越界被夹住（不会把图拖丢）');
eq(panGraphView({ k: 1, x: 0, y: 0 }, NaN, NaN).x, 0, '视口：NaN 平移量不污染坐标');

eq(graphScaleOf({ width: 1240, height: 1240 }), 1, '坐标：1240 方形容器比例为 1');
eq(graphScaleOf({ width: 620, height: 1240 }), 0.5, '坐标：meet 取短边（宽 620 → 0.5）');
eq(graphScaleOf({ width: 1240, height: 310 }), 0.25, '坐标：meet 取短边（高 310 → 0.25）');
eq(graphScaleOf(null), 1, '坐标：无 rect 时比例为 1');

const sq = { left: 0, top: 0, width: 500, height: 500 };
const mid = screenToGraphPoint(sq, 250, 250);
ok(near(mid.sx, 620, 1e-6) && near(mid.sy, 620, 1e-6), '坐标：500×500 容器正中 → viewBox 中心', mid);

const wide = { left: 100, top: 50, width: 1600, height: 600 };
const wc = screenToGraphPoint(wide, 600, 350);
ok(near(wc.sx, 0, 1e-6) && near(wc.sy, 620, 1e-6), '坐标：非方形容器按 meet 计算居中偏移', wc);

const WSC = graphScaleOf(wide);
const W_OX = (wide.width - 1240 * WSC) / 2;
const W_OY = (wide.height - 1240 * WSC) / 2;
const probe = screenToGraphPoint(wide, 321, 271);
ok(near(wide.left + W_OX + WSC * probe.sx, 321, 1e-6), '坐标：屏幕 → 图坐标往返（x）');
ok(near(wide.top + W_OY + WSC * probe.sy, 271, 1e-6), '坐标：屏幕 → 图坐标往返（y）');

eq(graphTransformOf({ k: 2, x: 10, y: -5 }), 'translate(10.00,-5.00) scale(2.0000)', '变换串：translate + scale 固定格式');
eq(graphTransformOf(null), 'translate(0.00,0.00) scale(1.0000)', '变换串：默认视口即原图');
eq(graphTransformOf({ k: 99, x: 0, y: 0 }), 'translate(0.00,0.00) scale(5.0000)', '变换串：输出前先夹紧缩放');

ok(gHtml.indexOf('class="sfv-glayer"') >= 0, '渲染：节点包在可整体变换的 sfv-glayer 图层里');
ok(gHtml.indexOf('transform="translate(0.00,0.00) scale(1.0000)"') >= 0, '渲染：默认视口即原图');
const zoomedHtml = renderGraph(gTag, { view: { k: 2, x: 10, y: -5 } });
ok(zoomedHtml.indexOf('transform="translate(10.00,-5.00) scale(2.0000)"') >= 0, '渲染：视口反映到图层 transform');
eq(countOf(zoomedHtml, /<g class="sfv-gfile/g), gTag.files.length, '渲染：缩放不影响文件节点数量');

ok(graphHtml.indexOf('sfv-gzoom') >= 0, '工具条：渲染缩放控件');
ok(graphHtml.indexOf('>100%<') >= 0, '工具条：默认显示 100%');
ok(graphHtml.indexOf('拖拽平移') >= 0 && graphHtml.indexOf('滚轮缩放') >= 0, '工具条：给出拖拽 / 滚轮操作提示');
const zoomPanelHtml = renderToStaticMarkup(
  React.createElement(PanelView, Object.assign({}, BASE_PROPS, { mode: 'graph', graphView: { k: 2, x: 0, y: 0 } })),
);
ok(zoomPanelHtml.indexOf('>200%<') >= 0, '工具条：百分比跟随视口变化');
const clampPanelHtml = renderToStaticMarkup(
  React.createElement(PanelView, Object.assign({}, BASE_PROPS, { mode: 'graph', graphView: { k: 100, x: 0, y: 0 } })),
);
ok(clampPanelHtml.indexOf('>500%<') >= 0, '工具条：百分比显示同样夹在上限内');

// 以下几条覆盖「纯函数断言碰不到」的接线细节，直接对源码做存在性断言防手滑删除。
ok(source.indexOf("addEventListener('wheel'") >= 0, '接线：滚轮走原生 addEventListener（而非 React 合成事件）');
ok(source.indexOf('{ passive: false }') >= 0, '接线：wheel 监听非被动，否则 preventDefault 无效');
ok(source.indexOf('onWheel:') < 0, '接线：不使用 React onWheel（它无法阻止容器滚动）');
ok(source.indexOf('touch-action: none') >= 0, '样式：脑图容器禁用触摸手势，拖拽时不带动页面');

/* ------------------------------------------------------------------ 汇总 */

const total = passed + failures.length;
if (failures.length > 0) {
  console.error('');
  for (const f of failures) console.error('  ✗ ' + f);
  console.error('');
  console.error('脑图测试：' + passed + ' 通过 / ' + failures.length + ' 失败（共 ' + total + ' 项）');
  process.exitCode = 1;
} else {
  console.log('脑图测试：' + passed + ' 通过 / 0 失败（共 ' + total + ' 项）');
  console.log('  · buildGraph 节点数 / 计数 / 排序 / 归属 / 几何 / 确定性');
  console.log('  · GraphView 连线与节点数量、失效标记、选中态、文字标签规则、空态');
  console.log('  · PanelView 列表 ↔ 脑图切换、按类型聚合、筛选联动');
  console.log('  · 视口 平移 / 焦点缩放 / 上下限夹紧 / 屏幕坐标换算 / 变换串 / 缩放控件');
}

/**
 * HTTP 路由层离线测试。
 *
 * 不启动 HTTP 服务：直接拿 createRoutes() 返回的 route.fetch 当函数调，
 * 用假 Request（只要 method / url / text()）驱动。这样既验证了业务响应，
 * 也验证了注册期硬约束（路径前缀、段字符、methods 非空不重复）。
 *
 * 原则与 vault.test.mjs 相同：**绝不写真实索引**，全部在临时副本上跑。
 * rebuild / rescan 的失败分支用 stub vault，避免真的去扫 436 份会话日志。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Vault } from '../lib/vault.js';
import { resolveDshHome, vaultPaths } from '../lib/paths.js';
import { createRoutes, ROUTE_PREFIX } from '../lib/routes.js';

const realHome = resolveDshHome(undefined, process.env);
const realIndexPath = vaultPaths(realHome).indexPath;
const hasFixture = existsSync(realIndexPath);
const skip = hasFixture ? false : '真实索引不存在（需先跑一次扫描）';

/** 只含副本索引的临时 DSH_HOME。 */
function makeSandbox() {
  const home = mkdtempSync(join(tmpdir(), 'sfv-routes-'));
  const paths = vaultPaths(home);
  mkdirSync(paths.vaultDir, { recursive: true });
  copyFileSync(realIndexPath, paths.indexPath);
  return { home, paths, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

/** 空 DSH_HOME（没有 index.json）。 */
function makeEmptyHome() {
  const home = mkdtempSync(join(tmpdir(), 'sfv-empty-'));
  return { home, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

/** 假 Request：route() 只在 POST 时读 body。 */
function fakeRequest(method, path, bodyText = '') {
  return {
    method,
    url: `http://127.0.0.1:1${path}`,
    text: async () => bodyText,
  };
}

function routeOf(routes, suffix, method = 'GET') {
  const path = `${ROUTE_PREFIX}/${suffix}`;
  const found = routes.find((r) => r.path === path);
  assert.ok(found, `没有找到路由 ${path}`);
  assert.ok(found.methods.includes(method), `${path} 不接受 ${method}`);
  return found;
}

/** 调一次路由并解出 {status, body}。 */
async function call(routes, suffix, { method = 'GET', body, query = '' } = {}) {
  const route = routeOf(routes, suffix, method);
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const res = await route.fetch(fakeRequest(method, `${ROUTE_PREFIX}/${suffix}${query}`, text));
  return { status: res.status, body: await res.json(), headers: res.headers };
}

/* ------------------------------------------------------- 注册期硬约束 */

test('路由表：路径唯一、每段合法、methods 非空不重复、都走 buffered', () => {
  const routes = createRoutes({});

  const seen = new Set();
  for (const r of routes) {
    assert.ok(r.path.startsWith(`${ROUTE_PREFIX}/`), `路径必须在 ${ROUTE_PREFIX} 下：${r.path}`);
    // DSH 的 fetch.register 只接受这些字符的段
    for (const seg of r.path.slice(1).split('/')) {
      assert.match(seg, /^[A-Za-z0-9_$.-]+$/, `路径段含非法字符：${seg}（${r.path}）`);
    }
    assert.ok(!seen.has(r.path), `路径重复注册会抛错：${r.path}`);
    seen.add(r.path);

    assert.ok(Array.isArray(r.methods) && r.methods.length > 0, `${r.path} 的 methods 不能为空`);
    assert.equal(new Set(r.methods).size, r.methods.length, `${r.path} 的 methods 有重复`);
    for (const m of r.methods) assert.equal(m, m.toUpperCase());
    assert.equal(r.requestBody, 'buffered', `${r.path} 需要 buffered 才能读 POST body`);
    assert.equal(typeof r.fetch, 'function');
  }

  // 客户端要用的端点一个不少（增删路由必须同步改这张表）
  assert.deepEqual(
    routes.map((r) => `${r.methods.join(',')} ${r.path.slice(ROUTE_PREFIX.length + 1)}`).sort(),
    [
      'GET detail',
      'GET state',
      'GET status',
      'GET,POST settings',
      'POST favorite',
      'POST rebuild',
      'POST rescan',
      'POST sync',
      'POST tags',
    ],
  );
});

/* --------------------------------------------------------------- 读接口 */

test('GET /state：ready 且带记录与 meta', { skip }, async () => {
  const box = makeSandbox();
  try {
    const routes = createRoutes(new Vault({ dshHome: box.home }));
    const { status, body, headers } = await call(routes, 'state');

    assert.equal(status, 200);
    assert.equal(headers.get('cache-control'), 'no-store');
    assert.match(headers.get('content-type'), /application\/json/);
    assert.equal(body.ok, true);
    assert.equal(body.ready, true);
    assert.ok(body.records.length > 100);
    assert.equal(body.meta.total, body.records.length);
    assert.ok(Array.isArray(body.meta.typeCategories));
    // 响应体必须能整包塞给客户端做本地过滤（144 条量级）
    assert.ok(JSON.stringify(body).length < 512 * 1024, '状态载荷过大，客户端过滤方案需要重新评估');
  } finally {
    box.dispose();
  }
});

test('GET /status：返回轻量状态，不含记录表', { skip }, async () => {
  const box = makeSandbox();
  try {
    const routes = createRoutes(new Vault({ dshHome: box.home }));
    const { status, body } = await call(routes, 'status');

    assert.equal(status, 200);
    assert.equal(body.ok, true);
    // /status 是扁平的（不套一层 status），因为路由本体就是状态
    assert.equal(body.ready, true);
    assert.equal(typeof body.stale, 'boolean');
    assert.equal(typeof body.recordCount, 'number');
    assert.ok(body.recordCount > 100);
    assert.equal(body.records, undefined, '/status 不该带记录表，也不该复用 records 这个名字');
  } finally {
    box.dispose();
  }
});

test('GET /detail：带 id 返回详情，缺 id 400，未知 id 404', { skip }, async () => {
  const box = makeSandbox();
  try {
    const vault = new Vault({ dshHome: box.home });
    const routes = createRoutes(vault);
    const first = vault.state().records[0];

    const ok = await call(routes, 'detail', { query: `?id=${encodeURIComponent(first.id)}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.detail.id, first.id);
    assert.ok(Array.isArray(ok.body.detail.sessions));

    const missing = await call(routes, 'detail');
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'bad-id');

    const unknown = await call(routes, 'detail', { query: '?id=deadbeefdeadbeef' });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.error.code, 'not-found');
  } finally {
    box.dispose();
  }
});

/* --------------------------------------------------------------- 写接口 */

test('POST /tags：正常写入并落盘，非法值逐类报错且不污染', { skip }, async () => {
  const box = makeSandbox();
  try {
    const vault = new Vault({ dshHome: box.home });
    const routes = createRoutes(vault);
    const id = vault.state().records[0].id;

    const ok = await call(routes, 'tags', {
      method: 'POST',
      body: { id, userTags: { type: 'pdf', content: ['手动标签'], date: '2026-01-02' } },
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body.record.userTags, {
      type: 'pdf',
      content: ['手动标签'],
      date: '2026-01-02',
    });
    assert.equal(ok.body.record.tags.type, 'pdf');
    assert.equal(ok.body.record.tags.date, '2026-01-02');

    const cases = [
      [{ id, userTags: { type: 'no-such-type' } }, 400, 'bad-type'],
      [{ id, userTags: { date: '2026/01/02' } }, 400, 'bad-date'],
      [{ id }, 400, 'bad-user-tags'],
      [{ id, userTags: null }, 400, 'bad-user-tags'],
      [{ id: 'deadbeefdeadbeef', userTags: {} }, 404, 'not-found'],
      [{ userTags: {} }, 400, 'bad-id'],
      ['{不是 JSON', 400, 'bad-json'],
      ['[]', 400, 'bad-json'],
      ['null', 400, 'bad-json'],
    ];
    for (const [payload, expectStatus, expectCode] of cases) {
      const res = await call(routes, 'tags', { method: 'POST', body: payload });
      assert.equal(res.status, expectStatus, `${JSON.stringify(payload)} 状态码应为 ${expectStatus}`);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.error.code, expectCode, `${JSON.stringify(payload)} 错误码应为 ${expectCode}`);
    }

    // 失败的写入不能改动已有数据（仍是第一次那次的成功结果）
    assert.deepEqual(vault.findRecord(id).userTags, {
      type: 'pdf',
      content: ['手动标签'],
      date: '2026-01-02',
    });
  } finally {
    box.dispose();
  }
});

test('POST /rebuild：空闲时启动后台任务，已在跑时复用并回传进度', async () => {
  // 用 stub vault，避免真的扫 436 份日志
  let calls = 0;
  const idle = {
    running: false,
    progress: { phase: 'idle', scanned: 0, total: 0, startedAt: 0 },
    rebuild(options) {
      calls += 1;
      this.running = true;
      this.lastOptions = options;
      return Promise.resolve({ ok: true }); // 立刻完成，不留悬挂 promise
    },
  };
  const routes = createRoutes(idle);
  const started = await call(routes, 'rebuild', { method: 'POST', body: {} });
  assert.equal(started.status, 200);
  assert.equal(started.body.started, true);
  assert.equal(started.body.running, true);
  assert.equal(calls, 1);
  assert.deepEqual(idle.lastOptions, { persist: true });

  const running = {
    running: true,
    progress: { phase: 'scan', scanned: 10, total: 100, startedAt: 1 },
    rebuild() {
      throw new Error('已在跑时不该再启动');
    },
  };
  const busy = await call(createRoutes(running), 'rebuild', { method: 'POST', body: {} });
  assert.equal(busy.status, 200);
  assert.equal(busy.body.started, false);
  assert.equal(busy.body.running, true);
  assert.deepEqual(busy.body.progress, { phase: 'scan', scanned: 10, total: 100, startedAt: 1 });

  // persist:false 要原样透传
  const nonPersist = {
    running: false,
    progress: null,
    rebuild(options) {
      this.lastOptions = options;
      return Promise.resolve();
    },
  };
  await call(createRoutes(nonPersist), 'rebuild', { method: 'POST', body: { persist: false } });
  assert.deepEqual(nonPersist.lastOptions, { persist: false });
});

test('POST /rebuild：后台失败只记日志，不把 500 抛给调用方', async () => {
  const routes = createRoutes({
    running: false,
    progress: null,
    rebuild: () => Promise.reject(new Error('磁盘满了')),
  });
  const err = console.error;
  console.error = () => {}; // 这条路径本来就该在宿主日志里留痕，测试输出里不需要
  try {
    const res = await call(routes, 'rebuild', { method: 'POST', body: {} });
    assert.equal(res.status, 200);
    assert.equal(res.body.started, true);
    // 让那条被吞掉的 rejection 有机会跑完，避免 unhandledRejection
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.error = err;
  }
});

test('POST /rescan：有索引返回结果与新状态；没索引 503 no-index', { skip }, async () => {
  const box = makeSandbox();
  try {
    const routes = createRoutes(new Vault({ dshHome: box.home }));
    const { status, body } = await call(routes, 'rescan', { method: 'POST', body: { persist: false } });
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.ok(Number.isFinite(body.result.existsCount), '结果里要有检查条数');
    assert.equal(body.result.existsCount + body.result.missingCount, body.status.recordCount);
    assert.equal(typeof body.result.retagged, 'number');
    assert.equal(body.status.stale, false, '刚 rescan 过就不该再判断为过期');
  } finally {
    box.dispose();
  }

  const empty = makeEmptyHome();
  try {
    const routes = createRoutes(new Vault({ dshHome: empty.home }));
    const res = await call(routes, 'rescan', { method: 'POST', body: {} });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'no-index');
  } finally {
    empty.dispose();
  }
});

test('未预料的异常统一变成 500 internal，不把堆栈抛给界面', { skip }, async () => {
  const box = makeSandbox();
  try {
    const vault = new Vault({ dshHome: box.home });
    vault.state = () => {
      throw new TypeError('boom');
    };
    const err = console.error;
    console.error = () => {}; // 宿主日志噪声静音，但保留恢复
    try {
      const res = await call(createRoutes(vault), 'state');
      assert.equal(res.status, 500);
      assert.equal(res.body.ok, false);
      assert.equal(res.body.error.code, 'internal');
      assert.ok(!String(res.body.error.message).includes('\n'), '错误信息不该带堆栈');
    } finally {
      console.error = err;
    }
  } finally {
    box.dispose();
  }
});

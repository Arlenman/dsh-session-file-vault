/**
 * apply() 接线测试（宿主半边）。
 *
 * 用假 ctx 跑 apply()，断言三件事：
 *   1. 索引任务被挂成 effect（插件卸载时能被叫停）；
 *   2. 6 条路由真的注册进了 connection.fetch.register；
 *   3. 单条路由注册失败不影响其余，connection 缺失也不抛。
 *
 * 全程把 DSH_HOME 指向临时副本，绝不碰真实索引。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, name, inject } from '../lib/index.js';
import { resolveDshHome, vaultPaths } from '../lib/paths.js';
import { createRoutes, ROUTE_PREFIX } from '../lib/routes.js';

const realHome = resolveDshHome(undefined, process.env);
const hasFixture = existsSync(vaultPaths(realHome).indexPath);
const skip = hasFixture ? false : '真实索引不存在（需先跑一次扫描）';

function makeSandbox() {
  const home = mkdtempSync(join(tmpdir(), 'sfv-apply-'));
  const paths = vaultPaths(home);
  mkdirSync(paths.vaultDir, { recursive: true });
  copyFileSync(vaultPaths(realHome).indexPath, paths.indexPath);
  return { home, paths, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

/** 假 ctx：记录 effect 与注册进来的路由。 */
function makeCtx({ services = ['connection'], registerThrowsOn = null } = {}) {
  const effects = [];
  const registered = [];

  const makeChild = () => ({
    get(service) {
      if (!services.includes(service)) return undefined;
      return {
        fetch: {
          register(route) {
            if (registerThrowsOn && route.path.includes(registerThrowsOn)) {
              throw new Error(`故意让 ${route.path} 注册失败`);
            }
            registered.push(route);
            return () => {
              const i = registered.indexOf(route);
              if (i >= 0) registered.splice(i, 1);
            };
          },
        },
      };
    },
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose;
    },
  });

  const ctx = {
    effect(fn, label) {
      const dispose = fn();
      effects.push({ label, dispose });
      return dispose;
    },
    inject(_services, cb) {
      // 等价于「服务已就绪」：同步回调
      cb(makeChild());
    },
  };
  return { ctx, effects, registered };
}

/** 在临时 DSH_HOME 下跑 fn（apply 内部自己 new Vault() 走的是 env）。 */
async function withTempHome(fn) {
  const box = makeSandbox();
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = box.home;
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => logs.push(['log', args.join(' ')]);
  console.error = (...args) => logs.push(['error', args.join(' ')]);
  try {
    await fn({ box, logs });
  } finally {
    console.log = origLog;
    console.error = origErr;
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    box.dispose();
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('导出契约：name / inject / apply', () => {
  assert.equal(name, 'dsh-session-file-vault');
  assert.deepEqual(inject, [], 'inject 必须留空，否则服务缺失会让插件卡在 pending');
  assert.equal(typeof apply, 'function');
});

test('apply()：路由表里的每一条都注册，索引任务挂成 effect', { skip }, async () => {
  await withTempHome(async ({ logs }) => {
    const { ctx, effects, registered } = makeCtx();
    apply(ctx);
    await settle();

    const expected = createRoutes({}).map((r) => r.path);
    assert.deepEqual(
      registered.map((r) => r.path).sort(),
      expected.slice().sort(),
      '注册的路径集合应与路由表一致',
    );
    for (const r of registered) {
      assert.ok(r.path.startsWith(`${ROUTE_PREFIX}/`));
      assert.equal(typeof r.fetch, 'function');
    }

    // 索引 task + 每条路由一个 effect
    const routeCount = createRoutes({}).length;
    assert.equal(effects.length, routeCount + 1, `effect 数应为 ${routeCount + 1}，实际 ${effects.length}`);
    assert.ok(
      effects.some((e) => String(e.label).includes('index')),
      '索引任务必须在 effect 里，卸载时才能叫停扫描',
    );

    // 索引是异步建的，但沙箱里有现成 index.json → 只 load，不扫描
    assert.ok(
      logs.some(([kind, text]) => kind === 'log' && text.includes('索引就绪')),
      `应打出「索引就绪」日志，实际：${JSON.stringify(logs)}`,
    );
    assert.ok(
      !logs.some(([kind, text]) => kind === 'error' && text.includes('建索引失败')),
      '沙箱里有索引，不该重建失败',
    );
  });
});

test('apply()：单条路由注册抛错时其余仍注册，且不抛出', { skip }, async () => {
  await withTempHome(async ({ logs }) => {
    const { ctx, registered } = makeCtx({ registerThrowsOn: '/tags' });
    assert.doesNotThrow(() => apply(ctx));
    await settle();

    const total = createRoutes({}).length;
    assert.equal(registered.length, total - 1, `应注册  条（tags 那条故意失败），实际 ${registered.length}`);
    assert.ok(!registered.some((r) => r.path.endsWith('/tags')));
    assert.ok(
      logs.some(([kind, text]) => kind === 'error' && text.includes('/tags') && text.includes('注册失败')),
      '注册失败必须留日志，否则界面少一个接口却毫无线索',
    );
  });
});

test('apply()：connection 服务缺席时只留日志，不抛错', { skip }, async () => {
  await withTempHome(async ({ logs }) => {
    const { ctx, registered } = makeCtx({ services: [] });
    assert.doesNotThrow(() => apply(ctx));
    await settle();

    assert.equal(registered.length, 0);
    assert.ok(
      logs.some(([kind, text]) => kind === 'error' && text.includes('register 不可用')),
      '缺服务要留一条明确日志',
    );
  });
});

test('apply() 返回的 disposer 幂等：重复调用不抛错', { skip }, async () => {
  await withTempHome(async () => {
    const { ctx, effects, registered } = makeCtx();
    apply(ctx);
    await settle();
    assert.equal(registered.length, createRoutes({}).length);

    for (const { dispose } of effects) {
      assert.doesNotThrow(() => dispose());
      assert.doesNotThrow(() => dispose(), 'disposer 必须幂等（Cordis 会重复调用）');
    }
    // 路由的 disposer 生效后应清空
    assert.equal(registered.length, 0);
  });
});

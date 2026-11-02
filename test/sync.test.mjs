/**
 * 同步 / 收藏 / 设置 —— 宿主半边离线测试。
 *
 * 与 routes.test.mjs 不同，这里**不依赖真实索引**：自己造一个临时 DSH_HOME +
 * 合成 index.json + 真实存在的源文件，所以换一台机器也能跑。
 *
 * 覆盖：
 *   · 设置校验（绝对路径、范围枚举、按类型必须选类型）
 *   · PATCH 语义（只改传进来的字段，其余保持）
 *   · 三种同步范围（全部 / 按类型 / 手动收藏）
 *   · 复制语义（首次复制 → 再同步跳过 → 源变了才更新）
 *   · 重名文件自动让开、重复同步名字稳定
 *   · 源文件缺失只记账不抛错
 *   · 收藏落盘 + 未知 id 报 404
 *   · 四条新路由的响应与错误码
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import { Vault, VaultError } from '../lib/vault.js';
import { resolveDshHome, vaultPaths } from '../lib/paths.js';
import { createRoutes, ROUTE_PREFIX } from '../lib/routes.js';
import {
  applySettingsPatch,
  defaultSettings,
  loadSettings,
  normalizeFavorites,
  normalizeSyncDir,
  normalizeSyncTypes,
  runSync,
  saveSettingsAtomic,
} from '../lib/sync.js';

/* ------------------------------------------------------------------ 夹具 */

const T0 = 1_700_000_000_000;

/** 造一个临时 DSH_HOME：src/ 下放真实文件，index.json 里放合成记录。 */
function makeBox(files) {
  const home = mkdtempSync(join(tmpdir(), 'sfv-sync-'));
  const paths = vaultPaths(home);
  mkdirSync(paths.vaultDir, { recursive: true });
  const srcDir = join(home, 'src');
  mkdirSync(srcDir, { recursive: true });

  const records = files.map((f, i) => {
    const p = join(srcDir, f.name);
    writeFileSync(p, f.body === undefined ? 'body of ' + f.name : f.body, 'utf8');
    const st = statSync(p);
    return {
      id: f.id || 'rec' + i,
      path: p,
      name: basename(p),
      dir: srcDir,
      ext: f.name.split('.').pop(),
      sizeBytes: st.size,
      mtimeMs: st.mtimeMs,
      exists: true,
      checkedAt: T0,
      firstPresentedAt: T0,
      lastPresentedAt: T0 + i * 1000,
      presentCount: 1,
      descriptions: [],
      sessions: [{ sessionId: 's' + i, project: 'p', projectLabel: '项目', cwd: srcDir, title: 't', time: T0 + i }],
      autoTags: {
        type: f.type || 'doc',
        content: f.tags || [],
        contentHash: String(i),
        localTitle: f.name,
        sources: [],
        extractedAt: T0,
      },
      userTags: { type: '', content: [], date: '' },
    };
  });

  writeFileSync(
    paths.indexPath,
    JSON.stringify({ version: 1, generatedAt: T0, dshHome: home, stats: {}, records }, null, 2),
    'utf8',
  );

  return {
    home,
    paths,
    srcDir,
    records,
    vault: () => new Vault({ dshHome: home }),
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}

function fakeRequest(method, path, bodyText = '') {
  return { method, url: `http://127.0.0.1:1${path}`, text: async () => bodyText };
}

function routeOf(routes, suffix, method = 'GET') {
  const p = `${ROUTE_PREFIX}/${suffix}`;
  const found = routes.find((r) => r.path === p);
  assert.ok(found, `没有找到路由 ${p}`);
  assert.ok(found.methods.includes(method), `${p} 不接受 ${method}`);
  return found;
}

async function call(routes, suffix, { method = 'GET', body } = {}) {
  const route = routeOf(routes, suffix, method);
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const res = await route.fetch(fakeRequest(method, `${ROUTE_PREFIX}/${suffix}`, text));
  return { status: res.status, body: await res.json() };
}

/* ------------------------------------------------------------ 设置校验 */

test('normalizeSyncDir：只认绝对路径，末尾分隔符去掉', () => {
  assert.equal(normalizeSyncDir(''), '');
  assert.equal(normalizeSyncDir(null), '');
  assert.equal(normalizeSyncDir('  '), '');
  assert.equal(normalizeSyncDir('D:\\dsh-vault-sync'), 'D:\\dsh-vault-sync');
  assert.equal(normalizeSyncDir('D:\\dsh-vault-sync\\'), 'D:\\dsh-vault-sync');
  assert.equal(normalizeSyncDir('D:/dsh-vault-sync/'), 'D:/dsh-vault-sync');
  assert.equal(normalizeSyncDir('C:\\'), 'C:\\', '盘根保留分隔符，不能变成 C:');
  assert.equal(normalizeSyncDir('\\\\nas\\share\\'), '\\\\nas\\share');
  assert.equal(normalizeSyncDir('/mnt/sync/'), '/mnt/sync');

  for (const bad of ['relative\\dir', 'dsh-vault-sync', './x', '..\\x']) {
    assert.throws(() => normalizeSyncDir(bad), VaultError, `相对路径必须拒：${bad}`);
  }
  assert.throws(() => normalizeSyncDir(123), VaultError);
});

test('normalizeSyncTypes / normalizeFavorites：过滤未知、去重、保序', () => {
  assert.deepEqual(normalizeSyncTypes(['doc', 'doc', 'nope', 'image']), ['doc', 'image']);
  assert.deepEqual(normalizeSyncTypes('doc'), []);
  assert.deepEqual(normalizeFavorites(['a', 'a', '', 'b', 3]), ['a', 'b']);
});

test('applySettingsPatch：PATCH 语义 —— 只改传进来的字段', () => {
  const prev = Object.assign(defaultSettings(), {
    syncDir: 'D:\\a',
    syncMode: 'type',
    syncTypes: ['doc'],
    favorites: ['x'],
  });

  const onlyDir = applySettingsPatch(prev, { syncDir: 'D:\\b' }, T0);
  assert.equal(onlyDir.syncDir, 'D:\\b');
  assert.equal(onlyDir.syncMode, 'type', '没传 syncMode 不能被重置回 all');
  assert.deepEqual(onlyDir.syncTypes, ['doc'], '没传 syncTypes 不能丢');
  assert.deepEqual(onlyDir.favorites, ['x'], '收藏与设置同文件，改设置不能丢收藏');
  assert.equal(onlyDir.updatedAt, T0);

  const onlyMode = applySettingsPatch(prev, { syncMode: 'manual' }, T0);
  assert.equal(onlyMode.syncMode, 'manual');
  assert.equal(onlyMode.syncDir, 'D:\\a');

  assert.throws(() => applySettingsPatch(prev, { syncMode: 'nope' }, T0), VaultError);
  assert.throws(() => applySettingsPatch(prev, {}, T0), VaultError);
  assert.throws(
    () => applySettingsPatch(Object.assign(defaultSettings(), { syncMode: 'all' }), { syncMode: 'type', syncTypes: [] }, T0),
    VaultError,
    '按类型但一个类型都没选，必须拒',
  );
});

test('设置落盘：原子写真读得回，损坏文件回落默认值', () => {
  const box = makeBox([]);
  try {
    const s = Object.assign(defaultSettings(), { syncDir: 'D:\\sync', syncMode: 'manual', favorites: ['a', 'b'] });
    saveSettingsAtomic(box.paths.settingsPath, s);
    const back = loadSettings(box.paths.settingsPath);
    assert.equal(back.syncDir, 'D:\\sync');
    assert.equal(back.syncMode, 'manual');
    assert.deepEqual(back.favorites, ['a', 'b']);

    writeFileSync(box.paths.settingsPath, '{ 坏掉的 json', 'utf8');
    const fallback = loadSettings(box.paths.settingsPath);
    assert.equal(fallback.syncDir, '');
    assert.equal(fallback.syncMode, 'all');
  } finally {
    box.dispose();
  }
});

/* -------------------------------------------------------------- 同步引擎 */

test('runSync：没设目录直接拒绝（不静默什么也不做）', () => {
  const box = makeBox([{ name: 'a.md', type: 'doc' }]);
  try {
    assert.throws(
      () => runSync({ items: box.records.map((r) => ({ ...r, tags: { type: 'doc', content: [] } })), settings: defaultSettings() }),
      (err) => err instanceof VaultError && err.code === 'no-sync-dir',
    );
  } finally {
    box.dispose();
  }
});

test('runSync(all)：首次复制、再同步跳过、源变了才更新', async () => {
  const box = makeBox([
    { name: 'a.md', type: 'doc', body: 'hello' },
    { name: 'b.png', type: 'image', body: 'png-bytes' },
  ]);
  try {
    const vault = box.vault();
    const outDir = join(box.home, 'out');
    vault.updateSettings({ syncDir: outDir, syncMode: 'all' });

    const r1 = vault.sync();
    assert.equal(r1.matched, 2);
    assert.equal(r1.copied, 2);
    assert.equal(r1.updated, 0);
    assert.equal(r1.skipped, 0);
    assert.equal(r1.failed, 0);
    assert.equal(readFileSync(join(outDir, 'a.md'), 'utf8'), 'hello');

    const r2 = vault.sync();
    assert.equal(r2.copied, 0);
    assert.equal(r2.updated, 0);
    assert.equal(r2.skipped, 2, '源没变 → 全部跳过，不重复覆盖');

    // 改源文件内容并同步大小/时间 → 应更新而不是新建
    writeFileSync(join(box.srcDir, 'a.md'), 'hello world, longer', 'utf8');
    const st = statSync(join(box.srcDir, 'a.md'));
    const rec = vault.load().records.find((x) => x.name === 'a.md');
    rec.sizeBytes = st.size;
    rec.mtimeMs = st.mtimeMs;

    const r3 = vault.sync();
    assert.equal(r3.updated, 1);
    assert.equal(r3.skipped, 1);
    assert.equal(readFileSync(join(outDir, 'a.md'), 'utf8'), 'hello world, longer');
  } finally {
    box.dispose();
  }
});

test('runSync(manual)：只同步收藏的文件', () => {
  const box = makeBox([
    { name: 'a.md', type: 'doc' },
    { name: 'b.md', type: 'doc' },
    { name: 'c.md', type: 'doc' },
  ]);
  try {
    const vault = box.vault();
    const outDir = join(box.home, 'out');
    vault.updateSettings({ syncDir: outDir, syncMode: 'manual' });
    assert.equal(vault.sync().matched, 0, '一个都没收藏 → 匹配 0 个');

    // 收藏中间那个
    vault.setFavorite(box.records[1].id, true);
    const r = vault.sync();
    assert.equal(r.matched, 1);
    assert.equal(r.copied, 1);
    assert.ok(readFileSync(join(outDir, 'b.md')));
    assert.throws(() => readFileSync(join(outDir, 'a.md')), '没收藏的不该被同步');

    // 取消收藏 → 下次不再匹配（但已同步的副本不删，删文件是用户的动作）
    vault.setFavorite(box.records[1].id, false);
    assert.equal(vault.sync().matched, 0);
  } finally {
    box.dispose();
  }
});

test('runSync(type)：只同步勾选类型', () => {
  const box = makeBox([
    { name: 'a.md', type: 'doc' },
    { name: 'b.png', type: 'image' },
    { name: 'c.json', type: 'data' },
  ]);
  try {
    const vault = box.vault();
    const outDir = join(box.home, 'out');
    vault.updateSettings({ syncDir: outDir, syncMode: 'type', syncTypes: ['doc', 'data'] });
    const r = vault.sync();
    assert.equal(r.matched, 2);
    assert.equal(r.copied, 2);
    assert.ok(readFileSync(join(outDir, 'a.md')));
    assert.ok(readFileSync(join(outDir, 'c.json')));
    assert.throws(() => readFileSync(join(outDir, 'b.png')), '图片没勾选，不该同步');
  } finally {
    box.dispose();
  }
});

test('runSync：不同目录下同名文件不互相覆盖，且重复同步名字稳定', () => {
  const home = mkdtempSync(join(tmpdir(), 'sfv-sync-dup-'));
  try {
    const paths = vaultPaths(home);
    mkdirSync(paths.vaultDir, { recursive: true });
    const d1 = join(home, 'p1');
    const d2 = join(home, 'p2');
    mkdirSync(d1, { recursive: true });
    mkdirSync(d2, { recursive: true });
    writeFileSync(join(d1, 'index.html'), 'AAA', 'utf8');
    writeFileSync(join(d2, 'index.html'), 'BBB', 'utf8');

    const mk = (id, p, i) => {
      const st = statSync(p);
      return {
        id,
        path: p,
        name: 'index.html',
        dir: join(p, '..'),
        ext: 'html',
        sizeBytes: st.size,
        mtimeMs: st.mtimeMs,
        exists: true,
        firstPresentedAt: T0,
        lastPresentedAt: T0 + i,
        presentCount: 1,
        descriptions: [],
        sessions: [],
        autoTags: { type: 'web', content: [], contentHash: String(i), localTitle: 'x', sources: [], extractedAt: T0 },
        userTags: { type: '', content: [], date: '' },
      };
    };
    writeFileSync(
      paths.indexPath,
      JSON.stringify({
        version: 1,
        generatedAt: T0,
        dshHome: home,
        stats: {},
        records: [mk('id1', join(d1, 'index.html'), 0), mk('id2', join(d2, 'index.html'), 1)],
      }),
      'utf8',
    );

    const vault = new Vault({ dshHome: home });
    const outDir = join(home, 'out');
    vault.updateSettings({ syncDir: outDir, syncMode: 'all' });
    const r1 = vault.sync();
    assert.equal(r1.copied, 2);
    assert.equal(readFileSync(join(outDir, 'index.html'), 'utf8'), 'AAA');
    assert.equal(readFileSync(join(outDir, 'index (2).html'), 'utf8'), 'BBB', '第二份同名文件自动让开成 (2)');

    // 再同步：名字必须稳定，不能越同步越多个 (3)(4)
    const r2 = vault.sync();
    assert.equal(r2.skipped, 2);
    assert.equal(r2.copied, 0);
    assert.ok(readFileSync(join(outDir, 'index (2).html')));
    assert.throws(() => readFileSync(join(outDir, 'index (3).html')), '名字必须稳定，不能每轮新增副本');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runSync：源文件缺失只记账，不中断其它文件', () => {
  const box = makeBox([
    { name: 'ok.md', type: 'doc' },
    { name: 'gone.md', type: 'doc' },
  ]);
  try {
    const vault = box.vault();
    const outDir = join(box.home, 'out');
    vault.updateSettings({ syncDir: outDir, syncMode: 'all' });

    // 让第二条记录指向一个不存在的路径
    const gone = vault.load().records[1];
    gone.path = join(box.srcDir, 'not-exists.md');
    gone.exists = false;

    const r = vault.sync();
    assert.equal(r.matched, 2);
    assert.equal(r.copied, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].message, /不在磁盘/);
    assert.ok(readFileSync(join(outDir, 'ok.md')), '一个失败不影响另一个成功');
  } finally {
    box.dispose();
  }
});

/* -------------------------------------------------------------- 收藏 / 状态 */

test('setFavorite：落盘、可取消、未知 id 报 404', () => {
  const box = makeBox([{ name: 'a.md', type: 'doc' }]);
  try {
    const vault = box.vault();
    const id = box.records[0].id;

    const r1 = vault.setFavorite(id, true);
    assert.equal(r1.favorite, true);
    assert.deepEqual(r1.favorites, [id]);

    // 换一个 Vault 实例（模拟重启）仍读得到
    const vault2 = new Vault({ dshHome: box.home });
    assert.deepEqual(vault2.favorites(), [id], '收藏必须跨实例持久化');

    const r2 = vault.setFavorite(id, false);
    assert.deepEqual(r2.favorites, []);

    assert.throws(
      () => vault.setFavorite('deadbeefdeadbeef', true),
      (err) => err instanceof VaultError && err.code === 'not-found',
    );
  } finally {
    box.dispose();
  }
});

test('state()：带 settings / favorites / lastSyncAt', () => {
  const box = makeBox([{ name: 'a.md', type: 'doc' }]);
  try {
    const vault = box.vault();
    const s0 = vault.state();
    assert.equal(s0.version, 2, 'state 载荷版本升到 2');
    assert.deepEqual(s0.settings, { syncDir: '', syncMode: 'all', syncTypes: [], updatedAt: 0 });
    assert.deepEqual(s0.favorites, []);
    assert.equal(s0.lastSyncAt, null);

    vault.updateSettings({ syncDir: join(box.home, 'out'), syncMode: 'manual' });
    vault.setFavorite(box.records[0].id, true);
    vault.sync();

    const s1 = vault.state();
    assert.equal(s1.settings.syncMode, 'manual');
    assert.deepEqual(s1.favorites, [box.records[0].id]);
    assert.ok(s1.lastSyncAt > 0, '同步过之后 lastSyncAt 必须有值');
  } finally {
    box.dispose();
  }
});

/* -------------------------------------------------------------- 路由层 */

test('路由：GET/POST settings', async () => {
  const box = makeBox([{ name: 'a.md', type: 'doc' }]);
  try {
    const routes = createRoutes(box.vault());
    const got = await call(routes, 'settings');
    assert.equal(got.status, 200);
    assert.equal(got.body.settings.syncDir, '');

    const outDir = join(box.home, 'out');
    const saved = await call(routes, 'settings', { method: 'POST', body: { syncDir: outDir, syncMode: 'all' } });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.syncDir, outDir);
    assert.equal(saved.body.settings.syncMode, 'all');

    const bad = await call(routes, 'settings', { method: 'POST', body: { syncDir: 'relative' } });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'bad-sync-dir');

    const badMode = await call(routes, 'settings', { method: 'POST', body: { syncMode: 'nope' } });
    assert.equal(badMode.status, 400);
    assert.equal(badMode.body.error.code, 'bad-sync-mode');
  } finally {
    box.dispose();
  }
});

test('路由：POST favorite', async () => {
  const box = makeBox([{ name: 'a.md', type: 'doc' }]);
  try {
    const routes = createRoutes(box.vault());
    const id = box.records[0].id;
    const on = await call(routes, 'favorite', { method: 'POST', body: { id, fav: true } });
    assert.equal(on.status, 200);
    assert.equal(on.body.favorite, true);
    assert.deepEqual(on.body.favorites, [id]);

    const off = await call(routes, 'favorite', { method: 'POST', body: { id, fav: false } });
    assert.deepEqual(off.body.favorites, []);

    const missing = await call(routes, 'favorite', { method: 'POST', body: { id: 'nope' } });
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not-found');
  } finally {
    box.dispose();
  }
});

test('路由：POST sync 成功与未设目录', async () => {
  const box = makeBox([{ name: 'a.md', type: 'doc' }]);
  try {
    const routes = createRoutes(box.vault());

    const noDir = await call(routes, 'sync', { method: 'POST', body: {} });
    assert.equal(noDir.status, 400);
    assert.equal(noDir.body.error.code, 'no-sync-dir');

    await call(routes, 'settings', { method: 'POST', body: { syncDir: join(box.home, 'out') } });
    const done = await call(routes, 'sync', { method: 'POST', body: {} });
    assert.equal(done.status, 200);
    assert.equal(done.body.report.copied, 1);
    assert.equal(done.body.report.mode, 'all');
  } finally {
    box.dispose();
  }
});

test('路由：索引没建好时 sync 给 503 而不是 500', async () => {
  const home = mkdtempSync(join(tmpdir(), 'sfv-sync-empty-'));
  try {
    const vault = new Vault({ dshHome: home });
    const routes = createRoutes(vault);
    const res = await call(routes, 'sync', { method: 'POST', body: {} });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'no-index');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- 真机索引端到端（不重启 DSH） */

const realHome = resolveDshHome(undefined, process.env);
const realIndexPath = vaultPaths(realHome).indexPath;
const hasRealIndex = existsSync(realIndexPath);

/**
 * 用本机真实索引跑一遍「设置 → 收藏 → 同步 → 核对落盘」。
 *
 * 这是宿主新路由在没有重启 DSH 之前能拿到的最强证据：走的是真实的 144 条记录、
 * 真实文件路径、真实 settings.json 落盘，只是 DSH 那一层 HTTP 换成了直接调 route.fetch。
 * 为了不把几十上百 MB 的文件复制到临时目录，只用「手动收藏」挑两个小文件。
 */
test('真机索引：设置 → 收藏 → 同步 → 核对落盘（幂等）', { skip: hasRealIndex ? false : '真实索引不存在' }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'sfv-realidx-'));
  try {
    const paths = vaultPaths(home);
    mkdirSync(paths.vaultDir, { recursive: true });
    copyFileSync(realIndexPath, paths.indexPath);

    const vault = new Vault({ dshHome: home });
    const routes = createRoutes(vault);
    const outDir = join(home, 'sync-out');

    // 挑两个「存在且不大」的文件，避免复制大文件
    const all = vault.state().records;
    const picks = all
      .filter((r) => r.exists !== false && typeof r.sizeBytes === 'number' && r.sizeBytes > 0 && r.sizeBytes < 256 * 1024)
      .slice(0, 2);
    assert.ok(picks.length === 2, `真实索引里应能挑到两个小文件，实际 ${picks.length}`);

    const saved = await call(routes, 'settings', {
      method: 'POST',
      body: { syncDir: outDir, syncMode: 'manual', syncTypes: [] },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.settings.syncMode, 'manual');

    // 未收藏时匹配 0
    const zero = await call(routes, 'sync', { method: 'POST', body: {} });
    assert.equal(zero.body.report.matched, 0);

    // 收藏这两个
    for (const p of picks) {
      const r = await call(routes, 'favorite', { method: 'POST', body: { id: p.id, fav: true } });
      assert.equal(r.status, 200);
      assert.ok(r.body.favorites.includes(p.id));
    }

    // 设置真的落到了 settings.json（不是只活在内存）
    assert.ok(existsSync(paths.settingsPath), 'settings.json 必须落盘');
    const onDisk = loadSettings(paths.settingsPath);
    assert.equal(onDisk.syncMode, 'manual');
    assert.equal(onDisk.favorites.length, picks.length);

    const once = await call(routes, 'sync', { method: 'POST', body: {} });
    const rep = once.body.report;
    assert.equal(once.status, 200);
    assert.equal(rep.matched, picks.length);
    assert.equal(rep.failed, 0, `真实文件不该失败：${JSON.stringify(rep.errors)}`);
    assert.equal(rep.copied + rep.updated, picks.length);

    const files = readdirSync(outDir).filter((n) => {
      try {
        return statSync(join(outDir, n)).isFile();
      } catch {
        return false;
      }
    });
    assert.equal(files.length, picks.length, `同步目录里应恰好 ${picks.length} 个文件，实际 ${files.length}`);

    // 内容与源文件逐字节一致（不是空壳文件）
    for (const p of picks) {
      const hit = files.find((f) => f === basename(p.path) || f.startsWith(basename(p.path).replace(/\.[^.]+$/, '')));
      assert.ok(hit, `没找到 ${basename(p.path)} 的副本，实际：${files.join(', ')}`);
      const a = readFileSync(p.path);
      const b = readFileSync(join(outDir, hit));
      assert.equal(b.length, a.length, `${hit} 体积应与源文件一致`);
      assert.equal(b.equals(a), true, `${hit} 内容应与源文件逐字节一致`);
    }

    // 再同步：幂等
    const twice = await call(routes, 'sync', { method: 'POST', body: {} });
    assert.equal(twice.body.report.copied, 0);
    assert.equal(twice.body.report.updated, 0);
    assert.equal(twice.body.report.skipped, picks.length);

    // 取消收藏后不再匹配，且已同步的副本不被删除（删文件是用户的动作）
    for (const p of picks) await call(routes, 'favorite', { method: 'POST', body: { id: p.id, fav: false } });
    const after = await call(routes, 'sync', { method: 'POST', body: {} });
    assert.equal(after.body.report.matched, 0);
    assert.equal(readdirSync(outDir).length, picks.length, '取消同步不应删掉已有副本');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

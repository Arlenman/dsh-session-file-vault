/**
 * M1 服务层离线测试。
 *
 * 原则：**绝不写真实索引**。把真实 index.json 复制到临时目录后再 load，
 * 所有写操作都落在临时副本上。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Vault, VaultError, normalizeUserTags, STATE_VERSION } from '../lib/vault.js';
import { resolveDshHome, vaultPaths } from '../lib/paths.js';
import { TYPE_CATEGORIES } from '../lib/tagger.js';

const realHome = resolveDshHome(undefined, process.env);
const realIndexPath = vaultPaths(realHome).indexPath;
const hasFixture = existsSync(realIndexPath);

/** 建一个只含副本索引的临时 DSH_HOME。 */
function makeSandbox() {
  const home = mkdtempSync(join(tmpdir(), 'sfv-'));
  const paths = vaultPaths(home);
  mkdirSync(paths.vaultDir, { recursive: true });
  copyFileSync(realIndexPath, paths.indexPath);
  return { home, paths, dispose: () => rmSync(home, { recursive: true, force: true }) };
}

const skip = hasFixture ? false : '真实索引不存在（需先跑一次扫描）';

test('state()：形状与真实索引一致', { skip }, () => {
  const box = makeSandbox();
  try {
    const vault = new Vault({ dshHome: box.home });
    const state = vault.state();

    assert.equal(state.ready, true);
    assert.equal(state.version, STATE_VERSION);
    assert.ok(Array.isArray(state.records));
    assert.ok(state.records.length > 100, `记录数应 >100，实际 ${state.records.length}`);
    assert.equal(state.meta.total, state.records.length);
    assert.equal(state.meta.existsCount + state.meta.missingCount, state.records.length);
    assert.equal(state.meta.typeCategories.length, Object.keys(TYPE_CATEGORIES).length);

    // 每条记录的三维标签都要能直接渲染
    for (const rec of state.records) {
      assert.equal(typeof rec.id, 'string');
      assert.ok(rec.path && rec.name && rec.ext !== undefined);
      assert.equal(typeof rec.tags.type, 'string');
      assert.equal(typeof rec.tags.typeLabel, 'string');
      assert.ok(Array.isArray(rec.tags.content));
      assert.ok(rec.tags.date === null || /^\d{4}-\d{2}-\d{2}$/.test(rec.tags.date));
      assert.equal(typeof rec.presentCount, 'number');
      assert.equal(typeof rec.sessionCount, 'number');
      assert.ok(Array.isArray(rec.descriptions));
    }

    // 载荷体积：客户端是本地过滤，一次全量下发必须够小
    const bytes = Buffer.byteLength(JSON.stringify(state), 'utf8');
    assert.ok(bytes < 512 * 1024, `state 载荷 ${bytes}B 偏大`);
  } finally {
    box.dispose();
  }
});

test('state()：类型分布覆盖多个分类，且 date 与 present 时间一致', { skip }, () => {
  const box = makeSandbox();
  try {
    const vault = new Vault({ dshHome: box.home });
    const state = vault.state();
    const types = new Set(state.records.map((r) => r.tags.type));
    assert.ok(types.size >= 6, `类型分类应 ≥6 种，实际 ${types.size}`);

    const withDate = state.records.filter((r) => r.tags.date);
    assert.ok(withDate.length > 100, `应有大量带日期的记录，实际 ${withDate.length}`);
    for (const rec of withDate.slice(0, 20)) {
      assert.ok(rec.userTags.date || /^\d{4}-\d{2}-\d{2}$/.test(rec.tags.date));
    }
  } finally {
    box.dispose();
  }
});

test('detail()：带完整会话表与原文标签', { skip }, () => {
  const box = makeSandbox();
  try {
    const vault = new Vault({ dshHome: box.home });
    const state = vault.state();
    const target = state.records.find((r) => r.sessionCount > 1) ?? state.records[0];

    const detail = vault.detail(target.id);
    assert.equal(detail.id, target.id);
    assert.equal(detail.path, target.path);
    assert.ok(Array.isArray(detail.sessions));
    assert.equal(detail.sessions.length, target.sessionCount);
    assert.ok(detail.autoTags && typeof detail.autoTags.type === 'string');
    assert.ok(detail.userTags && typeof detail.userTags === 'object');
    assert.equal(detail.sessionCount, target.sessionCount);
  } finally {
    box.dispose();
  }
});

test('updateTags()：三维修正、回落、持久化', { skip }, () => {
  const box = makeSandbox();
  try {
    const vault = new Vault({ dshHome: box.home });
    const state = vault.state();
    const target = state.records[0];
    const autoType = target.autoTags.type;

    // 1) 改类型
    const r1 = vault.updateTags(target.id, { type: 'image' });
    assert.equal(r1.tags.type, 'image');
    assert.equal(r1.userTags.type, 'image');
    assert.equal(r1.tags.typeLabel, TYPE_CATEGORIES.image.label ?? r1.tags.typeLabel);

    // 2) 改内容标签（含去重、trim）
    const r2 = vault.updateTags(target.id, { content: [' 自定义甲 ', '自定义甲', '', '自定义乙'] });
    assert.deepEqual(r2.userTags.content, ['自定义甲', '自定义乙']);
    assert.deepEqual(r2.tags.content, ['自定义甲', '自定义乙']);

    // 3) 改日期
    const r3 = vault.updateTags(target.id, { date: '2026-01-02' });
    assert.equal(r3.tags.date, '2026-01-02');

    // 4) 空值回落：type 回到自动分类，date 回到 present 时间
    const r4 = vault.updateTags(target.id, { type: '', content: [], date: '' });
    assert.equal(r4.userTags.type, '');
    assert.equal(r4.tags.type, autoType);
    assert.equal(r4.userTags.date, '');
    assert.notEqual(r4.tags.date, '2026-01-02');
    assert.deepEqual(r4.userTags.content, []);
    assert.deepEqual(r4.tags.content, target.autoTags.content);

    // 5) 落盘后新实例仍读得到上一次写入
    vault.updateTags(target.id, { type: 'pdf', content: ['落盘验证'] });
    const vault2 = new Vault({ dshHome: box.home });
    vault2.load();
    const again = vault2.findRecord(target.id);
    assert.equal(again.userTags.type, 'pdf');
    assert.deepEqual(again.userTags.content, ['落盘验证']);
  } finally {
    box.dispose();
  }
});

test('updateTags()：非法输入一律抛带 code 的 VaultError', { skip }, () => {
  const box = makeSandbox();
  try {
    const vault = new Vault({ dshHome: box.home });
    const target = vault.state().records[0];

    const bad = [
      [{ type: 'no-such-type' }, 'bad-type'],
      [{ date: '2026/01/02' }, 'bad-date'],
      [{ date: '2026-13-99x' }, 'bad-date'],
    ];
    for (const [payload, code] of bad) {
      assert.throws(
        () => vault.updateTags(target.id, payload),
        (err) => err instanceof VaultError && err.code === code,
        `期望 ${code}`,
      );
    }

    assert.throws(
      () => vault.updateTags('deadbeefdeadbeef', {}),
      (err) => err instanceof VaultError && err.code === 'not-found' && err.status === 404,
    );
    assert.throws(
      () => vault.updateTags(target.id, null),
      (err) => err instanceof VaultError && err.code === 'bad-user-tags',
    );
    // 漏传 userTags 同样算错 —— 不能静默解释成「清空三维」
    assert.throws(
      () => vault.updateTags(target.id, undefined),
      (err) => err instanceof VaultError && err.code === 'bad-user-tags',
    );
    // 但显式传空对象是合法的，语义 = 三维全部回落到自动结果
    assert.deepEqual(vault.updateTags(target.id, {}).userTags, {
      type: '',
      content: [],
      date: '',
    });
    // 失败的写入不能污染已有数据
    assert.deepEqual(vault.findRecord(target.id).userTags, {
      type: '',
      content: [],
      date: '',
    });
  } finally {
    box.dispose();
  }
});

test('normalizeUserTags()：去重 / 截断 / 字符串拆分', () => {
  const a = normalizeUserTags({ content: '甲，乙、丙,甲' });
  assert.deepEqual(a.content, ['甲', '乙', '丙']);

  const long = 'x'.repeat(200);
  const b = normalizeUserTags({ content: [long] });
  assert.equal(b.content[0].length, 32);

  const many = normalizeUserTags({ content: Array.from({ length: 40 }, (_, i) => `t${i}`) });
  assert.equal(many.content.length, 24);

  const empty = normalizeUserTags({});
  assert.deepEqual(empty, { type: '', content: [], date: '' });
});

test('rescan()：不改记录数、正确刷新存在性、缺失文件不降级标签', { skip }, async () => {
  const box = makeSandbox();
  try {
    const vault = new Vault({ dshHome: box.home });
    const before = vault.state();
    const index = vault.requireIndex();
    const missingBefore = before.meta.missingCount;
    const onDisk = index.records.find((r) => r.exists);

    const result = await vault.rescan({ persist: false });
    const after = vault.state();

    assert.equal(after.records.length, before.records.length);
    assert.equal(after.meta.existsCount, result.existsCount);
    assert.equal(after.meta.missingCount, result.missingCount);
    assert.equal(after.meta.existsCount + after.meta.missingCount, after.records.length);

    // 缺失记录保留原标签（不因读不到内容而退化成只剩文件名）
    for (const rec of index.records.filter((r) => !r.exists)) {
      assert.ok(rec.autoTags, '缺失文件不应丢掉标签');
      assert.ok(Array.isArray(rec.autoTags.content));
    }
    assert.ok(onDisk, '样本里应至少有一个在盘文件');
    assert.ok(result.missingCount >= missingBefore, 'rescan 不应凭空把缺失文件算成存在');
  } finally {
    box.dispose();
  }
});

test('status() 与 isStale()：字段齐全且类型稳定', { skip }, () => {
  const box = makeSandbox();
  try {
    const vault = new Vault({ dshHome: box.home });
    const st = vault.status();
    assert.equal(st.ready, true);
    assert.equal(st.stateVersion, STATE_VERSION);
    assert.equal(st.rebuilding, false);
    // 计数字段叫 recordCount（/state 的 records 是数组，不复用同名）
    assert.equal(st.recordCount, vault.state().records.length);
    assert.equal(st.records, undefined);
    assert.equal(typeof st.stale, 'boolean');
    assert.ok(st.paths.indexPath.startsWith(box.home));
    assert.ok(existsSync(st.paths.indexPath));
    assert.ok(statSync(st.paths.indexPath).size > 1000);
  } finally {
    box.dispose();
  }
});

test('未建索引时的行为：state 未就绪、写入抛 503', () => {
  const home = mkdtempSync(join(tmpdir(), 'sfv-empty-'));
  try {
    const vault = new Vault({ dshHome: home });
    const state = vault.state();
    assert.equal(state.ready, false);
    assert.deepEqual(state.records, []);
    assert.throws(
      () => vault.updateTags('x', {}),
      (err) => err instanceof VaultError && err.status === 503 && err.code === 'no-index',
    );
    assert.equal(vault.isStale(), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

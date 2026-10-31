#!/usr/bin/env node
/**
 * 全量扫描会话日志，重建索引并落盘到 <DSH_HOME>/session-file-vault/index.json。
 *
 * 用法：
 *   node scripts/build-index.mjs [--dsh-home <路径>] [--quiet]
 *
 * 索引是面板的数据源；插件首次加载时也会自动建，这个脚本用于手动重建与排查。
 */

import { statSync } from 'node:fs';

import { Vault } from '../lib/vault.js';

function argOf(name, fallback = undefined) {
  const i = process.argv.indexOf(name);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  return v === undefined || v.startsWith('--') ? fallback : v;
}

const quiet = process.argv.includes('--quiet');
const dshHome = argOf('--dsh-home', undefined);

const vault = new Vault(dshHome ? { dshHome } : {});

let lastPct = -1;
const t0 = Date.now();

if (!quiet) {
  console.log(`DSH_HOME : ${vault.dshHome}`);
  console.log(`会话日志 : ${vault.paths.sessionsRoot}`);
  console.log(`索引落点 : ${vault.paths.indexPath}`);
  console.log('扫描中…');
}

const index = await vault.rebuild({
  onProgress: (p) => {
    if (quiet) return;
    const pct = Math.floor((p.done / Math.max(1, p.total)) * 100);
    if (pct !== lastPct && pct % 10 === 0) {
      lastPct = pct;
      console.log(`  ${pct}% (${p.done}/${p.total})`);
    }
  },
});

const stats = index.stats ?? {};
const records = index.records;

let indexPath = vault.paths.indexPath;
let indexBytes = 0;
try {
  indexBytes = statSync(indexPath).size;
} catch {
  indexPath = `${indexPath}（写盘失败）`;
}

const typeCount = new Map();
const tagCount = new Map();
let untagged = 0;
for (const rec of records) {
  const type = rec.autoTags?.type ?? 'other';
  typeCount.set(type, (typeCount.get(type) ?? 0) + 1);
  const content = rec.autoTags?.content ?? [];
  if (content.length === 0) untagged += 1;
  for (const tag of content) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
}

const sortedTypes = [...typeCount.entries()].sort((a, b) => b[1] - a[1]);
const sortedTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]);

console.log('');
console.log(`完成：${((Date.now() - t0) / 1000).toFixed(1)}s（扫描 ${stats.scanMs ?? '?'}ms / 打标签 ${stats.tagMs ?? '?'}ms）`);
console.log(`  日志      ${stats.logFiles} 份 / ${(stats.logBytes / 1048576).toFixed(1)} MB / ${stats.projectDirs} 个项目目录 / 坏 ${stats.badLogs} 份`);
console.log(`  present   ${stats.presentedEvents} 个事件 / 分布在 ${stats.sessionsWithPresented} 个会话`);
console.log(`  文件      ${records.length} 个（在盘 ${stats.existsCount} / 缺失 ${stats.missingCount} / ${(stats.totalBytes / 1048576).toFixed(2)} MB）`);
console.log(`  标签      ${tagCount.size} 个不同内容标签，无标签 ${untagged} 个，复用 ${stats.autoTagsReused ?? 0} 条`);
console.log(`  索引      ${indexPath}（${(indexBytes / 1024).toFixed(1)} KB）`);
console.log('');
console.log('文件类型：');
for (const [type, n] of sortedTypes) console.log(`  ${type.padEnd(10)} ${String(n).padStart(4)}`);
console.log('');
console.log('内容标签 Top 15：');
for (const [tag, n] of sortedTags.slice(0, 15)) console.log(`  ${tag.padEnd(14)} ${String(n).padStart(4)}`);

process.exit(0);

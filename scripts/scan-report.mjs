/**
 * 离线扫描报告 —— 直接调 lib/indexer.js 跑全量扫描，不经过宿主。
 *
 * 用途：
 *   1. 验证索引器（帧解析 / 事件抽取 / 归并 / 存在性）在一台真实机器上的结果；
 *   2. 导出 description 语料，供提炼内容标签词表。
 *
 * 跑法：node scripts/scan-report.mjs [--out D:\path\dir]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  aggregateRecords,
  checkExistence,
  scanAllSessions,
  summarizeRecord,
} from '../lib/indexer.js';
import { resolveDshHome, vaultPaths } from '../lib/paths.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--dsh-home') out.dshHome = argv[++i];
  }
  return out;
}

/** 按 key 计数，返回倒序数组。 */
function tally(list) {
  const m = new Map();
  for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

function pad(n, w) {
  return String(n).padStart(w, ' ');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dshHome = resolveDshHome(args.dshHome);
  const paths = vaultPaths(dshHome);
  const outDir = args.out ? resolve(args.out) : join(dshHome, 'session-file-vault', 'reports');
  mkdirSync(outDir, { recursive: true });

  console.log(`DSH_HOME   : ${dshHome}`);
  console.log(`sessions   : ${paths.sessionsRoot}`);
  console.log('扫描中…');

  const { sessions, stats } = await scanAllSessions({
    sessionsRoot: paths.sessionsRoot,
    onProgress: ({ done, total }) => {
      if (done % 100 === 0 || done === total) process.stdout.write(`\r  ${done}/${total}`);
    },
  });
  process.stdout.write('\n');

  const records = aggregateRecords(sessions);
  const exist = checkExistence(records);

  // ── 控制台摘要 ─────────────────────────────────────────────
  console.log('');
  console.log('=== 扫描统计 ===');
  console.log(`项目目录        : ${stats.projectDirs}`);
  console.log(`会话日志        : ${stats.logFiles} 份 / ${(stats.logBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log(`解压失败        : ${stats.badLogs}`);
  console.log(`present 事件    : ${stats.presentedEvents}（分布在 ${stats.sessionsWithPresented} 个会话）`);
  console.log(`去重文件        : ${records.length}`);
  console.log(`磁盘上仍在      : ${exist.existsCount} / 缺失 ${exist.missingCount} / ${(exist.totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`耗时            : ${stats.elapsedMs} ms`);

  const extTally = tally(records.map((r) => r.ext || '(无扩展名)'));
  console.log('');
  console.log('=== 类型分布（去重路径） ===');
  for (const [k, v] of extTally) console.log(`  ${pad(k, 10)} ${pad(v, 4)}`);

  const dateTally = tally(records.map((r) => new Date(r.lastPresentedAt ?? 0).toISOString().slice(0, 10)));
  console.log('');
  console.log('=== 日期分布（按最后交付，UTC 日期） ===');
  for (const [k, v] of dateTally.sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${k}  ${pad(v, 4)}  ${'#'.repeat(v)}`);
  }

  const countTally = tally(records.map((r) => r.presentCount));
  console.log('');
  console.log('=== 重复交付次数分布 ===');
  for (const [k, v] of countTally.sort((a, b) => a[0] - b[0])) {
    console.log(`  交付 ${k} 次 : ${v} 个文件`);
  }

  // ── 落盘：完整索引 + 语料 ──────────────────────────────────
  const index = {
    version: 1,
    generatedAt: Date.now(),
    dshHome,
    stats,
    records,
  };
  writeFileSync(join(outDir, 'index.preview.json'), JSON.stringify(index, null, 2), 'utf8');

  const corpus = records.map((r) => ({
    id: r.id,
    name: r.name,
    ext: r.ext,
    dir: r.dir,
    exists: r.exists,
    presentCount: r.presentCount,
    descriptions: r.descriptions,
    sessions: r.sessions.map((s) => ({ projectLabel: s.projectLabel, title: s.title })),
  }));
  writeFileSync(join(outDir, 'corpus.json'), JSON.stringify(corpus, null, 2), 'utf8');

  // 纯文本质料便于人眼读
  const lines = [];
  for (const r of corpus) {
    lines.push(`## ${r.name}  [${r.ext}] x${r.presentCount}${r.exists ? '' : ' (缺失)'}`);
    lines.push(`   ${r.dir}`);
    for (const d of r.descriptions) lines.push(`   · ${d}`);
    for (const s of r.sessions.slice(0, 3)) lines.push(`   @ ${s.projectLabel ?? ''} / ${s.title ?? '(无标题)'}`);
    lines.push('');
  }
  writeFileSync(join(outDir, 'corpus.txt'), lines.join('\n'), 'utf8');

  const slim = records.map(summarizeRecord);
  writeFileSync(join(outDir, 'records.slim.json'), JSON.stringify(slim, null, 2), 'utf8');

  console.log('');
  console.log(`产物目录: ${outDir}`);
  console.log('  index.preview.json / corpus.json / corpus.txt / records.slim.json');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

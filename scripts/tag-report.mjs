/**
 * 标签体检 —— 跑全量扫描 + 自动打标签，输出标签分布与逐条样本。
 * 用法：node scripts/tag-report.mjs [--out <dir>]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  aggregateRecords,
  checkExistence,
  scanAllSessions,
  ymdLocal,
} from '../lib/indexer.js';
import { buildAutoTags, effectiveTags, typeLabel } from '../lib/tagger.js';
import { resolveDshHome, vaultPaths } from '../lib/paths.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i];
    else if (argv[i] === '--dsh-home') out.dshHome = argv[++i];
  }
  return out;
}

function tally(list) {
  const m = new Map();
  for (const k of list) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dshHome = resolveDshHome(args.dshHome);
  const paths = vaultPaths(dshHome);
  const outDir = args.out ? resolve(args.out) : join(paths.vaultDir, 'reports');
  mkdirSync(outDir, { recursive: true });

  const { sessions, stats } = await scanAllSessions({ sessionsRoot: paths.sessionsRoot });
  const records = aggregateRecords(sessions);
  checkExistence(records);

  const t0 = Date.now();
  for (const rec of records) {
    rec.autoTags = buildAutoTags(rec);
  }
  const tagMs = Date.now() - t0;

  const eff = records.map((r) => effectiveTags(r, ymdLocal));

  console.log(`扫描 ${stats.logFiles} 份 / ${records.length} 条记录，打标签 ${tagMs} ms`);
  console.log('');

  console.log('=== 文件类型（归一化后） ===');
  for (const [k, v] of tally(eff.map((e) => typeLabel(e.type)))) {
    console.log(`  ${k.padEnd(14)} ${String(v).padStart(4)}`);
  }

  const tagCount = tally(eff.flatMap((e) => e.content));
  console.log('');
  console.log(`=== 内容标签分布（共 ${tagCount.length} 个不同标签） ===`);
  for (const [k, v] of tagCount) console.log(`  ${k.padEnd(14)} ${String(v).padStart(4)}  ${'#'.repeat(v)}`);

  const noTag = records.filter((r) => (eff[records.indexOf(r)]?.content ?? []).length === 0).length;
  const runTime = records.length ? records.reduce((a, r) => a + (r.autoTags?.content?.length ?? 0), 0) / records.length : 0;
  console.log('');
  console.log(`无标签记录：${noTag} / ${records.length}`);
  console.log(`平均标签数：${runTime.toFixed(2)}`);

  const srcTally = tally(records.flatMap((r) => r.autoTags?.sources ?? []));
  console.log(`来源分布  ：${srcTally.map(([k, v]) => `${k}=${v}`).join('  ')}`);

  const withTitle = records.filter((r) => r.autoTags?.localTitle).length;
  console.log(`本地解析出标题：${withTitle} / ${records.filter((r) => r.exists).length} 在盘文件`);

  // ── 逐条样本 ──────────────────────────────────────────────
  const lines = [];
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const e = eff[i];
    lines.push(`## ${r.name}  [${typeLabel(e.type)}] ${e.date ?? '-'}${r.exists ? '' : ' (缺失)'}`);
    if (r.autoTags?.localTitle) lines.push(`   标题: ${r.autoTags.localTitle}`);
    lines.push(`   标签: ${e.content.join(' / ') || '(无)'}`);
    lines.push(`   说明: ${r.descriptions[0] ?? ''}`);
    lines.push('');
  }
  writeFileSync(join(outDir, 'tag-report.txt'), lines.join('\n'), 'utf8');

  // 标签集（供 M2 的筛选下拉直接用）
  writeFileSync(
    join(outDir, 'tag-dictionary.json'),
    JSON.stringify(
      {
        generatedAt: Date.now(),
        types: Object.entries({
          doc: '文档', web: '网页', image: '图片', pdf: 'PDF', sheet: '表格',
          data: '数据', code: '代码', archive: '压缩包', app: '程序/快捷方式', other: '其它',
        }).map(([key, label]) => ({ key, label, count: eff.filter((e) => e.type === key).length })),
        contentTags: tagCount.map(([tag, count]) => ({ tag, count })),
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log('');
  console.log(`产物: ${join(outDir, 'tag-report.txt')}`);
  console.log(`      ${join(outDir, 'tag-dictionary.json')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

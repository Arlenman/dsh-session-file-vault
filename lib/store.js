/**
 * 索引的落盘与编排。
 *
 * 落盘位置 `<DSH_HOME>/session-file-vault/index.json`（约 90 KB / 144 条记录）。
 * 里面存的是**绝对路径 + 元数据**，不含文件内容 —— 暴露面与其它插件一致
 * （`~/.dsh` 本来就会被备份工具打包），但不会额外把文档正文带到别处。
 *
 * 两条不变量：
 *   1. `autoTags` 与 `userTags` 严格分离。重扫只写 `autoTags`，用户手动改的
 *      标签永远保留在 `userTags`；展示时 user 优先（见 tagger.effectiveTags）。
 *   2. 写盘是原子的（tmp + rename），宿主被杀不会留下半截 JSON。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  aggregateRecords,
  checkExistence,
  hashPath,
  normalizePath,
  scanAllSessions,
  ymdLocal,
} from './indexer.js';
import { buildAutoTags } from './tagger.js';

export const INDEX_VERSION = 1;

/** 空用户标签。userTags 的三个维度都是「用户覆盖」，空串/空数组 = 用自动结果。 */
export function emptyUserTags() {
  return { type: '', content: [], date: '' };
}

/** 读索引；不存在或损坏返回 null（损坏时把坏文件改名留档，便于排查）。 */
export function loadIndex(indexPath) {
  if (!existsSync(indexPath)) return null;
  let raw;
  try {
    raw = readFileSync(indexPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || !Array.isArray(data.records)) return null;
    return data;
  } catch {
    try {
      renameSync(indexPath, `${indexPath}.corrupt-${Date.now()}`);
    } catch {
      /* 留档失败也不该阻塞启动 */
    }
    return null;
  }
}

/** 原子写：同目录 tmp + rename。 */
export function saveIndexAtomic(indexPath, data) {
  mkdirSync(dirname(indexPath), { recursive: true });
  const tmp = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    renameSync(tmp, indexPath);
  } catch (err) {
    // 目标被占用（编辑器/杀软扫描）时最多重试 3 次，再不行就报错交给上层
    let lastErr = err;
    for (let i = 0; i < 3; i++) {
      try {
        renameSync(tmp, indexPath);
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw lastErr;
  }
}

/**
 * 把旧索引里的用户标签搬回新记录。
 *
 * 只用 id 匹配 —— id 是归一化路径的 sha1，本身就代表「同一个文件」。
 * 用户标签是**不可再生数据**，任何重建路径都必须走这里。
 *
 * @param {Array} newRecords
 * @param {Array} oldRecords
 * @returns {number} 恢复了几条
 */
export function restoreUserTags(newRecords, oldRecords) {
  if (!Array.isArray(oldRecords) || oldRecords.length === 0) {
    for (const rec of newRecords) rec.userTags = emptyUserTags();
    return 0;
  }
  const byId = new Map();
  for (const old of oldRecords) {
    if (old && typeof old.id === 'string') byId.set(old.id, old);
  }
  let restored = 0;
  for (const rec of newRecords) {
    const old = byId.get(rec.id);
    const ut = old?.userTags;
    if (ut && (ut.type != null || ut.date != null || (Array.isArray(ut.content) && ut.content.length))) {
      rec.userTags = {
        type: ut.type ?? null,
        content: Array.isArray(ut.content) ? [...ut.content] : [],
        date: ut.date ?? null,
      };
      restored += 1;
    } else {
      rec.userTags = emptyUserTags();
    }
  }
  return restored;
}

/**
 * 复用旧的 autoTags（内容指纹没变时跳过重算）。
 * @returns {number} 复用了多少条
 */
export function reuseAutoTags(newRecords, oldRecords) {
  if (!Array.isArray(oldRecords) || oldRecords.length === 0) return 0;
  const byId = new Map();
  for (const old of oldRecords) if (old?.id) byId.set(old.id, old);
  let reused = 0;
  for (const rec of newRecords) {
    const old = byId.get(rec.id);
    const prev = old?.autoTags;
    if (!prev || typeof prev.contentHash !== 'string') continue;
    // 用「指纹算出来后与旧的一致」判定；这里先构造一次拿 hash，成本远低于读文件
    const probe = buildAutoTags(rec, { readContent: false });
    if (probe.contentHash === prev.contentHash) {
      rec.autoTags = prev;
      reused += 1;
    }
  }
  return reused;
}

/**
 * 全量重建索引。
 *
 * @param {object} opts
 * @param {string} opts.sessionsRoot
 * @param {string} opts.indexPath
 * @param {string} opts.dshHome
 * @param {(p:object)=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.shouldStop]
 * @param {boolean} [opts.persist=true]
 * @returns {Promise<object>} 新的索引对象
 */
export async function rebuildIndex(opts) {
  const { sessionsRoot, indexPath, dshHome, onProgress, shouldStop } = opts;
  const t0 = Date.now();

  const old = loadIndex(indexPath);
  const oldRecords = old?.records ?? [];

  const { sessions, stats } = await scanAllSessions({ sessionsRoot, onProgress, shouldStop });
  const scanMs = Date.now() - t0;

  const records = aggregateRecords(sessions);
  const existence = checkExistence(records);

  const tTag = Date.now();
  const reused = reuseAutoTags(records, oldRecords);
  for (const rec of records) {
    if (!rec.autoTags) rec.autoTags = buildAutoTags(rec);
  }
  const tagMs = Date.now() - tTag;

  const restored = restoreUserTags(records, oldRecords);

  const index = {
    version: INDEX_VERSION,
    generatedAt: Date.now(),
    dshHome,
    sessionsRoot,
    stats: {
      ...stats,
      scanMs,
      tagMs,
      totalMs: Date.now() - t0,
      autoTagsReused: reused,
      userTagsRestored: restored,
      existsCount: existence.existsCount,
      missingCount: existence.missingCount,
      totalBytes: existence.totalBytes,
    },
    records,
  };

  if (opts.persist !== false) saveIndexAtomic(indexPath, index);
  return index;
}

/**
 * 单条记录的详情视图（详情面板 / 右侧预览用）。
 * @param {object} rec
 */
export function recordDetail(rec) {
  return {
    id: rec.id,
    path: rec.path,
    name: rec.name,
    dir: rec.dir,
    ext: rec.ext,
    sizeBytes: rec.sizeBytes,
    mtimeMs: rec.mtimeMs,
    exists: rec.exists,
    checkedAt: rec.checkedAt,
    firstPresentedAt: rec.firstPresentedAt,
    lastPresentedAt: rec.lastPresentedAt,
    presentCount: rec.presentCount,
    descriptions: rec.descriptions ?? [],
    sessions: rec.sessions ?? [],
    autoTags: rec.autoTags ?? null,
    userTags: rec.userTags ?? emptyUserTags(),
  };
}

/** 供测试与外部工具复用。 */
export const __internals = { aggregateRecords, hashPath, normalizePath, ymdLocal };

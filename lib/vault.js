/**
 * 服务层：索引的内存态 + 重建/刷新/改标签。
 *
 * 刻意不依赖 Cordis —— 宿主半边（lib/index.js）只做接线，这个模块可以脱离 DSH
 * 直接 new 出来跑离线测试（test/vault.test.mjs 就是这么用的）。
 */

import { statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { resolveDshHome, vaultPaths } from './paths.js';
import { VaultError } from './errors.js';
import {
  applySettingsPatch,
  loadSettings,
  runSync,
  saveSettingsAtomic,
} from './sync.js';
import {
  INDEX_VERSION,
  emptyUserTags,
  loadIndex,
  saveIndexAtomic,
  rebuildIndex,
  recordDetail,
} from './store.js';
import { checkExistence, ymdLocal } from './indexer.js';
import {
  TYPE_CATEGORIES,
  typeLabel,
  typeOfExt,
  buildAutoTags,
  effectiveTags,
} from './tagger.js';

/** state 载荷自身的格式版本，客户端据此判断要不要提示升级。 */
export const STATE_VERSION = 2;

const TYPE_KEYS = new Set(Object.keys(TYPE_CATEGORIES));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CONTENT_TAGS = 24;
const MAX_TAG_LEN = 32;
const STALE_CHECK_TTL_MS = 30_000;

/** 带 code 的业务错误（定义在 errors.js，这里 re-export 保持既有 import 路径可用）。 */
export { VaultError };

/** 把用户输入的内容标签数组清干净：去空、去重、截断。 */
function normalizeContentTags(input) {
  if (!Array.isArray(input)) {
    if (typeof input === 'string') input = input.split(/[,，、\n]/);
    else return [];
  }
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().replace(/\s+/g, ' ').slice(0, MAX_TAG_LEN);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_CONTENT_TAGS) break;
  }
  return out;
}

/**
 * 校验并规范化一次标签编辑。
 * 三个维度都允许「清空」以回落到自动结果 —— 空串 / 空数组即代表不覆盖。
 */
export function normalizeUserTags(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new VaultError('bad-user-tags', 'userTags 必须是对象');
  }
  const out = emptyUserTags();

  if ('type' in input) {
    const raw = input.type;
    if (raw === null || raw === undefined || raw === '') {
      // 回落到自动分类
    } else if (typeof raw !== 'string' || !TYPE_KEYS.has(raw)) {
      throw new VaultError('bad-type', `未知的文件类型分类：${String(raw)}`);
    } else {
      out.type = raw;
    }
  }

  if ('content' in input) {
    out.content = normalizeContentTags(input.content);
  }

  if ('date' in input) {
    const raw = input.date;
    if (raw === null || raw === undefined || raw === '') {
      // 回落到 present 时间
    } else if (typeof raw !== 'string' || !DATE_RE.test(raw)) {
      throw new VaultError('bad-date', 'date 必须是 YYYY-MM-DD');
    } else {
      out.date = raw;
    }
  }

  return out;
}

/** 找最新的会话日志 mtime，用来判断索引是否落后于会话。 */
function newestLogMtime(sessionsRoot) {
  let newest = 0;
  let projects;
  try {
    projects = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const proj of projects) {
    if (!proj.isDirectory()) continue;
    const projDir = join(sessionsRoot, proj.name);
    let sessions;
    try {
      sessions = readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sess of sessions) {
      if (!sess.isDirectory()) continue;
      try {
        const st = statSync(join(projDir, sess.name, 'session.v4.jsonl.zstd'));
        if (st.mtimeMs > newest) newest = st.mtimeMs;
      } catch {
        /* 目录里可能只有别的文件，忽略 */
      }
    }
  }
  return newest;
}

export class Vault {
  /**
   * @param {object} [opts]
   * @param {string} [opts.dshHome] 显式指定 DSH_HOME（测试用）
   * @param {NodeJS.ProcessEnv} [opts.env]
   * @param {()=>number} [opts.now]
   */
  constructor(opts = {}) {
    this.env = opts.env ?? process.env;
    this.now = opts.now ?? (() => Date.now());
    this.dshHome = opts.dshHome ?? resolveDshHome(undefined, this.env);
    this.paths = vaultPaths(this.dshHome);

    /** @type {object|null} 最近一次可用索引 */
    this.index = null;
    /** @type {Promise<object>|null} 正在跑的 rebuild */
    this._rebuilding = null;
    /** @type {string|null} */
    this.lastError = null;
    /** 后台任务进度 */
    this.progress = { phase: 'idle', scanned: 0, total: 0, startedAt: 0 };
    this._stopRequested = false;
    this._staleCache = { at: 0, value: false };
    /** @type {object|null} 同步设置 + 收藏（懒加载，与索引互不影响） */
    this._settings = null;
  }

  /* ------------------------------------------------------------- 同步/收藏 */

  /** 读同步设置（只读一次，之后走内存）。 */
  loadSettings() {
    if (this._settings) return this._settings;
    this._settings = loadSettings(this.paths.settingsPath);
    return this._settings;
  }

  /** 客户端可见的设置视图（不含 syncLog：那是内部映射，不该出现在界面载荷里）。 */
  settingsView() {
    const s = this.loadSettings();
    return {
      syncDir: s.syncDir,
      syncMode: s.syncMode,
      syncTypes: [...s.syncTypes],
      updatedAt: s.updatedAt,
    };
  }

  /** 收藏的文件 id 列表。 */
  favorites() {
    return [...this.loadSettings().favorites];
  }

  /** 改设置（PATCH 语义：只处理请求体里出现的字段）。 */
  updateSettings(body) {
    const next = applySettingsPatch(this.loadSettings(), body, this.now());
    this._settings = next;
    saveSettingsAtomic(this.paths.settingsPath, next);
    return this.settingsView();
  }

  /** 收藏 / 取消收藏一个文件（id 必须存在，否则 404）。 */
  setFavorite(id, favorite) {
    const rec = this.findRecord(id);
    const s = this.loadSettings();
    const set = new Set(s.favorites);
    if (favorite) set.add(rec.id);
    else set.delete(rec.id);
    s.favorites = [...set];
    s.updatedAt = this.now();
    saveSettingsAtomic(this.paths.settingsPath, s);
    return { id: rec.id, favorite: Boolean(favorite), favorites: [...s.favorites] };
  }

  /** 按当前设置把文件复制一份到同步目录。 */
  sync() {
    const index = this.requireIndex();
    const s = this.loadSettings();
    const items = index.records.map((r) => this.slim(r));
    const { report, syncLog } = runSync({ items, settings: s, now: this.now() });
    s.syncLog = syncLog;
    saveSettingsAtomic(this.paths.settingsPath, s);
    return report;
  }

  /* ---------------------------------------------------------------- 索引 */

  /** 是否正在重建（路由层据此决定是「启动」还是「已在跑」）。 */
  get running() {
    return Boolean(this._rebuilding);
  }

  /** 从磁盘读索引进内存（不重建）。读不到返回 null。 */
  load() {
    if (this.index) return this.index;
    const loaded = loadIndex(this.paths.indexPath);
    if (loaded && Array.isArray(loaded.records)) {
      this.index = loaded;
    }
    return this.index;
  }

  /** 首次使用时确保有索引：没有就后台建一份（不阻塞调用方）。 */
  async ensure() {
    const loaded = this.load();
    if (loaded) return loaded;
    return this.rebuild().catch((err) => {
      this.lastError = err?.message ?? String(err);
      return null;
    });
  }

  /**
   * 全量重建。已在跑时复用同一个 promise（不排队、不并发）。
   * @param {{persist?:boolean}=} opts
   */
  rebuild(opts = {}) {
    if (this._rebuilding) return this._rebuilding;
    this._stopRequested = false;
    const startedAt = this.now();
    this.progress = { phase: 'scan', scanned: 0, total: 0, startedAt };

    const run = (async () => {
      try {
        const index = await rebuildIndex({
          sessionsRoot: this.paths.sessionsRoot,
          indexPath: this.paths.indexPath,
          dshHome: this.dshHome,
          persist: opts.persist !== false,
          shouldStop: () => this._stopRequested,
          onProgress: (p) => {
            this.progress = {
              phase: 'scan',
              scanned: p.done ?? 0,
              total: p.total ?? 0,
              current: p.file ?? null,
              startedAt,
            };
          },
        });
        this.index = index;
        this.lastError = null;
        this._staleCache = { at: this.now(), value: false };
        this.progress = { phase: 'idle', scanned: 0, total: 0, startedAt: 0 };
        return index;
      } catch (err) {
        this.lastError = err?.message ?? String(err);
        this.progress = { phase: 'error', scanned: 0, total: 0, startedAt: 0 };
        throw err;
      } finally {
        this._rebuilding = null;
      }
    })();

    this._rebuilding = run;
    return run;
  }

  requestStop() {
    this._stopRequested = true;
  }

  /** 索引是否落后于会话日志（有新的 present 事件还没进索引）。 */
  isStale() {
    const index = this.load();
    if (!index) return true;
    const t = this.now();
    if (t - this._staleCache.at < STALE_CHECK_TTL_MS) return this._staleCache.value;
    const newest = newestLogMtime(this.paths.sessionsRoot);
    const value = newest > (index.generatedAt ?? 0);
    this._staleCache = { at: t, value };
    return value;
  }

  /* -------------------------------------------------------------- 刷新态 */

  /**
   * 轻量刷新：只重查磁盘存在性 / 大小 / mtime，内容指纹变了的重算标签。
   * 不遍历会话日志（那要十几秒），所以新出现的文件不会因此被纳入。
   */
  async rescan({ persist = true } = {}) {
    const index = this.load();
    if (!index) return this.rebuild();

    const records = index.records;
    const now = this.now();
    // checkExistence 会就地改写 sizeBytes/mtimeMs，所以先快照再比对「文件本体变没变」
    const before = new Map(
      records.map((r) => [
        r.id,
        { size: r.sizeBytes ?? null, mtime: r.mtimeMs ?? null, hash: r.autoTags?.contentHash ?? null },
      ]),
    );
    const existence = checkExistence(records, now);

    let retagged = 0;
    for (const rec of records) {
      const b = before.get(rec.id);
      const kept = rec.autoTags ?? null;
      // 文件已不在：保留上次解析出的标签，不降级成「只剩文件名」的结果
      if (!rec.exists) {
        if (kept) kept.extractedAt = now;
        continue;
      }
      // 大小与 mtime 都没动、且此前解析成功 → 跳过读文件，只刷新检查时间
      if (b && b.hash !== null && b.size === rec.sizeBytes && b.mtime === rec.mtimeMs) {
        kept.extractedAt = now;
        continue;
      }
      const fresh = buildAutoTags(rec);
      if (!kept || fresh.contentHash !== b?.hash) {
        rec.autoTags = fresh;
        retagged += 1;
      } else {
        kept.extractedAt = now;
      }
    }

    index.generatedAt = this.now();
    index.stats = {
      ...(index.stats ?? {}),
      existsCount: existence.existsCount,
      missingCount: existence.missingCount,
      totalBytes: existence.totalBytes,
      lastRescanAt: this.now(),
    };
    this._staleCache = { at: this.now(), value: false };
    if (persist) saveIndexAtomic(this.paths.indexPath, index);
    return { ...existence, retagged };
  }

  /* ------------------------------------------------------------- 读/写记录 */

  requireIndex() {
    const index = this.load();
    if (!index) {
      throw new VaultError('no-index', '索引还没建好，请先重建索引', 503);
    }
    return index;
  }

  findRecord(id) {
    if (typeof id !== 'string' || !id) {
      throw new VaultError('bad-id', '缺少文件 id');
    }
    const rec = this.requireIndex().records.find((r) => r.id === id);
    if (!rec) throw new VaultError('not-found', `找不到文件记录：${id}`, 404);
    return rec;
  }

  /**
   * 改一条记录的用户标签（三维都可改；传空值即还原成自动结果）。
   * @param {string} id
   * @param {object} userTags 形如 {type?, content?, date?}
   */
  updateTags(id, userTags) {
    const rec = this.findRecord(id);
    // 不做 userTags ?? {} 兜底：漏传/传 null 一律报错，否则一次手误就会静默清空三个维度。
    const next = normalizeUserTags(userTags);
    rec.userTags = next;
    rec.tagsUpdatedAt = this.now();
    saveIndexAtomic(this.paths.indexPath, this.requireIndex());
    return this.slim(rec);
  }

  /* --------------------------------------------------------------- 视图层 */

  /** 客户端列表/脑图用的一条记录（不含完整会话表，省一半体积）。 */
  slim(rec) {
    const tags = effectiveTags(rec, ymdLocal);
    const sessions = Array.isArray(rec.sessions) ? rec.sessions : [];
    const last = sessions.reduce(
      (acc, s) => (acc === null || (s?.time ?? 0) > (acc.time ?? 0) ? s : acc),
      null,
    );
    return {
      id: rec.id,
      path: rec.path,
      name: rec.name,
      dir: rec.dir,
      ext: rec.ext,
      sizeBytes: rec.sizeBytes ?? null,
      mtimeMs: rec.mtimeMs ?? null,
      exists: rec.exists !== false,
      firstPresentedAt: rec.firstPresentedAt ?? null,
      lastPresentedAt: rec.lastPresentedAt ?? null,
      presentCount: rec.presentCount ?? 1,
      descriptions: rec.descriptions ?? [],
      localTitle: rec.autoTags?.localTitle ?? null,
      sources: rec.autoTags?.sources ?? [],
      tags,
      autoTags: {
        type: rec.autoTags?.type ?? typeOfExt(rec.ext),
        content: rec.autoTags?.content ?? [],
      },
      userTags: rec.userTags ?? emptyUserTags(),
      sessionCount: sessions.length,
      lastSession: last
        ? {
            sessionId: last.sessionId,
            title: last.title ?? null,
            projectLabel: last.projectLabel ?? null,
            cwd: last.cwd ?? null,
            time: last.time ?? null,
          }
        : null,
    };
  }

  /** 最近一次同步时间（从 syncLog 里取最大值；没同步过返回 null）。 */
  lastSyncAt() {
    const log = this.loadSettings().syncLog ?? {};
    let newest = 0;
    for (const v of Object.values(log)) {
      if (v && typeof v.at === 'number' && v.at > newest) newest = v.at;
    }
    return newest || null;
  }

  /** GET /state 的全部内容。 */
  state() {
    const index = this.load();
    if (!index) {
      return {
        ready: false,
        version: STATE_VERSION,
        indexVersion: INDEX_VERSION,
        rebuilding: Boolean(this._rebuilding),
        progress: this.progress,
        lastError: this.lastError,
        settings: this.settingsView(),
        favorites: this.favorites(),
        lastSyncAt: this.lastSyncAt(),
        records: [],
        meta: null,
      };
    }
    const records = index.records.map((r) => this.slim(r));
    return {
      ready: true,
      version: STATE_VERSION,
      indexVersion: index.version ?? INDEX_VERSION,
      rebuilding: Boolean(this._rebuilding),
      progress: this.progress,
      lastError: this.lastError,
      stale: this.isStale(),
      settings: this.settingsView(),
      favorites: this.favorites(),
      lastSyncAt: this.lastSyncAt(),
      meta: {
        generatedAt: index.generatedAt ?? null,
        dshHome: index.dshHome ?? this.dshHome,
        stats: index.stats ?? {},
        total: records.length,
        existsCount: records.filter((r) => r.exists).length,
        missingCount: records.filter((r) => !r.exists).length,
        typeCategories: Object.entries(TYPE_CATEGORIES).map(([key, def], index) => ({
          key,
          label: def.label ?? typeLabel(key),
          order: index,
        })),
      },
      records,
    };
  }

  /** 单条详情：带上完整会话表、描述历史、原文标签。 */
  detail(id) {
    const rec = this.findRecord(id);
    const d = recordDetail(rec);
    const tags = effectiveTags(rec, ymdLocal);
    return {
      ...d,
      tags,
      sessionCount: (d.sessions ?? []).length,
    };
  }

  /** 运行状态（供 /status 与界面角标）。 */
  status() {
    const index = this.load();
    return {
      ready: Boolean(index),
      indexVersion: index?.version ?? null,
      stateVersion: STATE_VERSION,
      rebuilding: Boolean(this._rebuilding),
      progress: this.progress,
      lastError: this.lastError,
      generatedAt: index?.generatedAt ?? null,
      stale: index ? this.isStale() : true,
      // 刻意不叫 records：/state 的 records 是数组，这里是计数，同名会让客户端误用 .length
      recordCount: index?.records?.length ?? 0,
      existsCount: index?.stats?.existsCount ?? 0,
      missingCount: index?.stats?.missingCount ?? 0,
      paths: {
        dshHome: this.dshHome,
        vaultDir: this.paths.vaultDir,
        indexPath: this.paths.indexPath,
        sessionsRoot: this.paths.sessionsRoot,
      },
    };
  }
}

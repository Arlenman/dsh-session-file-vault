/**
 * 同步设置 + 收藏 + 「把散落的文件复制一份到本地目录」。
 *
 * 与 DSH 无关，纯 Node 实现 —— 可以脱离宿主直接跑离线测试。
 *
 * 落盘：`<DSH_HOME>/session-file-vault/settings.json`
 *   {
 *     syncDir:   "D:\\dsh-vault-sync",   // 空串 = 还没设置
 *     syncMode:  "all" | "type" | "manual",
 *     syncTypes: ["doc", "image"],        // syncMode=type 时生效
 *     favorites: ["<record id>", ...],    // syncMode=manual 时生效（点爱心收藏）
 *     syncLog:   { "<id>": { name, size, mtimeMs, at } },  // 已同步到哪个文件名，保证重复同步不撞名
 *     updatedAt: 0
 *   }
 *
 * 三条设计约定：
 *   1. **收藏是用户数据，绝不能因为重建索引丢失** —— 它按 record id（= 归一化路径的 sha1）存，
 *      而 id 本身就代表「同一个文件」，所以重建后照样对得上。
 *   2. **同步是复制，不是移动**；源文件一个字节都不改。
 *   3. **同名不覆盖别人的文件**：目标目录里已经存在、但不是这条记录上次写的那个文件时，
 *      自动让开成 `名字 (2).ext`；同一条记录再次同步则覆盖自己上次那份。
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join } from 'node:path';

import { VaultError } from './errors.js';
import { TYPE_CATEGORIES } from './tagger.js';

export const SETTINGS_VERSION = 1;
export const SYNC_MODES = ['all', 'type', 'manual'];
export const SYNC_MODE_LABELS = {
  all: '全部文件',
  type: '按类型',
  manual: '手动收藏',
};

const TYPE_KEYS = new Set(Object.keys(TYPE_CATEGORIES));
const MAX_FAVORITES = 5000;
const MAX_SYNC_LOG = 3000;
const MAX_ERRORS = 24;
const MAX_NAME_LEN = 120;
/** 判定「目标文件还是上次那份」的 mtime 容差：NTFS 与 JS 毫秒在不同 API 上会有 <2s 的舍入差。 */
const SAME_FILE_MTIME_MS = 2000;

/** 默认设置（也是「从没配置过」时的返回值）。 */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    syncDir: '',
    syncMode: 'all',
    syncTypes: [],
    favorites: [],
    syncLog: {},
    updatedAt: 0,
  };
}

/**
 * 校验同步目录。
 * 必须显式给出绝对路径 —— 相对路径会相对于宿主进程的 cwd，用户以为的位置与实际位置不一致，
 * 属于「静默写错地方」那一类事故，宁可直接拒。
 */
export function normalizeSyncDir(input) {
  if (input === null || input === undefined) return '';
  if (typeof input !== 'string') throw new VaultError('bad-sync-dir', 'syncDir 必须是字符串');
  const raw = input.trim();
  if (!raw) return '';
  if (raw.indexOf('\u0000') >= 0) throw new VaultError('bad-sync-dir', '路径里不能包含 NUL 字符');
  const isWinAbs = /^[A-Za-z]:[\\/]/.test(raw);
  const isUnc = raw.startsWith('\\\\') && raw.length > 2;
  const isPosixAbs = raw.startsWith('/');
  if (!isWinAbs && !isUnc && !isPosixAbs) {
    throw new VaultError('bad-sync-dir', '同步目录必须是绝对路径，例如 D:\\dsh-vault-sync');
  }
  // 去掉末尾分隔符，但 `C:\` 这种根保留一个
  let out = raw;
  while (out.length > 1 && /[\\/]$/.test(out) && !/^[A-Za-z]:[\\/]$/.test(out)) out = out.slice(0, -1);
  return out;
}

/** 内容标签同步类型列表：只留已知分类，去重。 */
export function normalizeSyncTypes(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const key = raw.trim();
    if (!TYPE_KEYS.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** 收藏 id 列表：去空、去重、截断（id 是 16 位 hex，这里放宽到 80 只为兼容历史格式）。 */
export function normalizeFavorites(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!id || id.length > 80 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_FAVORITES) break;
  }
  return out;
}

function normalizeSyncLog(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
  const out = {};
  for (const [id, v] of Object.entries(input)) {
    if (typeof id !== 'string' || !id || !v || typeof v !== 'object') continue;
    if (typeof v.name !== 'string' || !v.name) continue;
    out[id] = {
      name: v.name,
      size: typeof v.size === 'number' ? v.size : null,
      mtimeMs: typeof v.mtimeMs === 'number' ? v.mtimeMs : null,
      at: typeof v.at === 'number' ? v.at : 0,
    };
  }
  return out;
}

/** 原子写：同目录 tmp + rename（与索引落盘同一套语义）。 */
export function saveSettingsAtomic(settingsPath, data) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  try {
    renameSync(tmp, settingsPath);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** 读设置；文件不存在 / 损坏一律回落到默认值（设置丢了不该让面板打不开）。 */
export function loadSettings(settingsPath) {
  const base = defaultSettings();
  if (!existsSync(settingsPath)) return base;
  let raw;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch {
    return base;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return base;
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return base;
  const out = base;
  try {
    out.syncDir = normalizeSyncDir(data.syncDir);
  } catch {
    out.syncDir = '';
  }
  out.syncMode = SYNC_MODES.includes(data.syncMode) ? data.syncMode : 'all';
  out.syncTypes = normalizeSyncTypes(data.syncTypes);
  out.favorites = normalizeFavorites(data.favorites);
  out.syncLog = normalizeSyncLog(data.syncLog);
  out.updatedAt = typeof data.updatedAt === 'number' ? data.updatedAt : 0;
  return out;
}

/**
 * 把一次 PATCH 语义的请求体合并到现有设置上。
 * 只处理出现过的键 —— 前端只发改动的字段，避免「没传的字段被打回默认值」。
 *
 * @param {object} prev 现有设置（loadSettings 的返回值）
 * @param {object} body 请求体
 * @param {number} [nowMs]
 */
export function applySettingsPatch(prev, body, nowMs = Date.now()) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new VaultError('bad-settings', '设置请求体必须是对象');
  }
  const next = {
    ...prev,
    syncTypes: [...prev.syncTypes],
    favorites: [...prev.favorites],
    syncLog: { ...prev.syncLog },
  };
  let touched = 0;

  if ('syncDir' in body) {
    next.syncDir = normalizeSyncDir(body.syncDir);
    touched += 1;
  }
  if ('syncMode' in body) {
    const mode = body.syncMode;
    if (!SYNC_MODES.includes(mode)) {
      throw new VaultError('bad-sync-mode', '同步范围只能是 all / type / manual 三者之一');
    }
    next.syncMode = mode;
    touched += 1;
  }
  if ('syncTypes' in body) {
    next.syncTypes = normalizeSyncTypes(body.syncTypes);
    touched += 1;
  }

  if (!touched) throw new VaultError('bad-settings', '没有可更新的字段（syncDir / syncMode / syncTypes）');

  // 组合校验放在最后：单看每个字段都合法，但「模式=按类型 却一个类型都没选」是无意义的
  if (next.syncMode === 'type' && next.syncTypes.length === 0) {
    throw new VaultError('bad-sync-types', '同步范围选了「按类型」，请至少勾选一个文件类型');
  }

  next.updatedAt = nowMs;
  return next;
}

/** 去掉路径里 Windows 不允许的字符，并裁到合理长度。 */
function sanitizeName(name) {
  const raw = String(name || 'file');
  const cleaned = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim();
  const safe = cleaned || 'file';
  return safe.length > MAX_NAME_LEN ? safe.slice(0, MAX_NAME_LEN) : safe;
}

/**
 * 给这条记录在目标目录里找一个不冲突的文件名。
 * @param {string} dir
 * @param {Map<string,string>} taken 小写文件名 → 占用它的 record id
 * @param {object} rec
 */
function allocateName(dir, taken, rec) {
  const base = sanitizeName(rec.name);
  const ext = extname(base);
  const stem = ext ? base.slice(0, base.length - ext.length) : base;
  let candidate = base;
  let n = 2;
  for (;;) {
    const lower = candidate.toLowerCase();
    const occupied = taken.has(lower) || existsSync(join(dir, candidate));
    if (!occupied) break;
    candidate = `${stem} (${n})${ext}`;
    n += 1;
    if (n > 500) {
      candidate = `${stem} (${Date.now()})${ext}`;
      break;
    }
  }
  taken.set(candidate.toLowerCase(), rec.id);
  return candidate;
}

function pushError(report, rec, message) {
  if (report.errors.length >= MAX_ERRORS) return;
  report.errors.push({ id: rec.id, name: rec.name, message: String(message) });
}

/**
 * 执行一次同步（复制）。
 *
 * @param {object} opts
 * @param {Array<object>} opts.items 瘦身记录（vault.slim 的产物，含 id/name/path/exists/sizeBytes/mtimeMs/tags）
 * @param {object} opts.settings loadSettings 的返回值
 * @param {number} [opts.now]
 * @returns {{report:object, syncLog:object, favorites:string[]}} syncLog / favorites 需要调用方落盘
 */
export function runSync(opts) {
  const { items, settings, now = Date.now() } = opts;
  const dir = settings.syncDir;
  if (!dir) {
    throw new VaultError('no-sync-dir', '还没有设置同步目录，先点右上角「设置」填一个目录', 400);
  }
  if (!Array.isArray(items)) throw new VaultError('bad-items', '缺少可同步的记录列表');

  const mode = settings.syncMode;
  const favorites = Array.isArray(settings.favorites) ? settings.favorites : [];
  const favSet = new Set(favorites);

  let pool;
  if (mode === 'all') {
    pool = items;
  } else if (mode === 'type') {
    const want = new Set(Array.isArray(settings.syncTypes) ? settings.syncTypes : []);
    pool = items.filter((r) => want.has(r.tags && r.tags.type));
  } else {
    pool = items.filter((r) => favSet.has(r.id));
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new VaultError('bad-sync-dir', '同步目录建不出来：' + (err?.message ?? err));
  }
  let st;
  try {
    st = statSync(dir);
  } catch (err) {
    throw new VaultError('bad-sync-dir', '同步目录不可用：' + (err?.message ?? err));
  }
  if (!st.isDirectory()) throw new VaultError('bad-sync-dir', '同步目录指向的不是一个文件夹');

  const log = normalizeSyncLog(settings.syncLog);
  const taken = new Map();
  for (const [id, v] of Object.entries(log)) taken.set(v.name.toLowerCase(), id);

  const report = {
    dir,
    mode,
    matched: pool.length,
    copied: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    errors: [],
    at: now,
  };

  for (const rec of pool) {
    if (rec.exists === false) {
      report.failed += 1;
      pushError(report, rec, '源文件已不在磁盘上');
      continue;
    }
    const prev = log[rec.id];
    let name = prev ? prev.name : '';
    const lower = name ? name.toLowerCase() : '';
    const ownedByOther = lower ? taken.has(lower) && taken.get(lower) !== rec.id : false;
    if (!name || ownedByOther) {
      name = allocateName(dir, taken, rec);
    } else {
      taken.set(lower, rec.id);
    }

    const target = join(dir, name);
    const srcSize = typeof rec.sizeBytes === 'number' ? rec.sizeBytes : null;
    const srcMtime = typeof rec.mtimeMs === 'number' ? rec.mtimeMs : null;
    try {
      let same = false;
      if (prev && existsSync(target)) {
        try {
          const ts = statSync(target);
          same =
            srcSize !== null &&
            ts.size === srcSize &&
            srcMtime !== null &&
            Math.abs(ts.mtimeMs - srcMtime) < SAME_FILE_MTIME_MS;
        } catch {
          same = false;
        }
      }
      if (same) {
        report.skipped += 1;
        continue;
      }
      copyFileSync(rec.path, target);
      log[rec.id] = { name, size: srcSize, mtimeMs: srcMtime, at: now };
      if (prev) report.updated += 1;
      else report.copied += 1;
    } catch (err) {
      report.failed += 1;
      pushError(report, rec, err?.message ?? String(err));
    }
  }

  // 只保留仍在索引里的 id，按时间裁到上限（否则频繁重建会让 settings.json 无限长）
  const alive = new Set(items.map((r) => r.id));
  const entries = Object.entries(log)
    .filter(([id]) => alive.has(id))
    .sort((a, b) => (b[1].at ?? 0) - (a[1].at ?? 0))
    .slice(0, MAX_SYNC_LOG);

  return { report, syncLog: Object.fromEntries(entries), favorites };
}

/** 供测试复用。 */
export const __internals = { sanitizeName, allocateName, TYPE_KEYS };

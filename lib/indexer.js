/**
 * 索引器 —— 从 DSH 会话日志里抽出「主动交付」的文件，归并成文件库记录。
 *
 * 数据来源唯一：`session.v4.jsonl.zstd` 里的 `deliverables/presented` 事件。
 * 之所以只认它：`present` 工具是模型主动声明「这是给你的交付物」的唯一动作，
 * 每次都带一段模型写的中文说明（description），是零成本的内容标签来源。
 * 其它候选（workspace/changes、tool/call 路径映射、文件系统扫描）都已排除：
 * 前者是内存态、会话 dispose 即丢；后两者会把大量中间产物混进来。
 *
 * 实测口径（本机 2026-10）：436 份会话日志 / 125 个 present 事件 / 144 个去重路径。
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const SESSION_LOG_NAME = 'session.v4.jsonl.zstd';
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 单次解析里我们要找的事件类型（其余 99% 的行直接跳过）。 */
const TYPE_SESSION = '"type":"session"';
const TYPE_TITLE = '"type":"session/title"';
const TYPE_PRESENTED = '"type":"deliverables/presented"';

/**
 * 解多帧 zstd。
 *
 * DSH 的会话日志是**追加写入的多帧 zstd**，而 Node 的 `createZstdDecompress`
 * 流在第一个帧结束时就收尾（实测 1.3 MB 的文件只解出 202 字节）。所以必须
 * 按帧魔数切开、逐帧 `zstdDecompressSync`。
 *
 * 注意：文件内容里也可能恰好出现 `28 B5 2F FD` 字节，命中后解压会抛错 ——
 * 这时把切片向后扩到**下一个**魔数重试，直到解出来或没有更多候选为止。
 *
 * @param {Buffer} buf
 * @returns {Buffer|null} 解压后的字节；整个文件找不到有效帧时返回 null
 */
export function decodeZstdFrames(buf) {
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i);
    }
  }
  if (starts.length === 0) return null;

  const parts = [];
  let k = 0;
  while (k < starts.length) {
    let ok = false;
    for (let j = k + 1; j <= starts.length; j++) {
      const from = starts[k];
      const to = j < starts.length ? starts[j] : buf.length;
      try {
        parts.push(zstdDecompressSync(buf.subarray(from, to)));
        k = j;
        ok = true;
        break;
      } catch {
        // 假魔数或帧尾截断 —— 扩到下一个候选继续试
      }
    }
    if (!ok) k += 1;
  }
  if (parts.length === 0) return null;
  return Buffer.concat(parts);
}

/** 读一份会话日志并解压成文本。失败返回 null（单份坏文件不该拖垮整轮扫描）。 */
export function readSessionText(logPath) {
  try {
    const raw = readFileSync(logPath);
    const text = decodeZstdFrames(raw);
    return text ? text.toString('utf8') : null;
  } catch {
    return null;
  }
}

/**
 * 从一段会话日志文本里抽三样东西：会话头、最终标题、全部 present 记录。
 * @param {string} text
 */
export function parseSessionText(text) {
  let header = null;
  let title = null;
  const presented = [];

  const lines = text.split('\n');
  for (const line of lines) {
    if (line.length < 12) continue;
    // 行首必须是 `{` —— 压缩流拼接处可能留下空白行
    if (line.charCodeAt(0) !== 0x7b) continue;

    if (line.indexOf(TYPE_PRESENTED) !== -1) {
      try {
        const ev = JSON.parse(line);
        const files = Array.isArray(ev?.data?.files) ? ev.data.files : [];
        if (files.length) {
          presented.push({
            seq: ev.seq,
            time: typeof ev.time === 'number' ? ev.time : null,
            turn: ev?.data?.turn ?? null,
            callId: ev?.data?.callId ?? null,
            files: files
              .map((f) => ({
                path: typeof f?.path === 'string' ? f.path : '',
                description: typeof f?.description === 'string' ? f.description.trim() : '',
              }))
              .filter((f) => f.path.length > 0),
          });
        }
      } catch {
        // 半截行（进程被杀时可能留下）—— 跳过
      }
      continue;
    }

    if (line.indexOf(TYPE_TITLE) !== -1) {
      try {
        const ev = JSON.parse(line);
        const t = ev?.data?.title;
        if (typeof t === 'string' && t.trim()) title = t.trim();
      } catch {
        /* 同上 */
      }
      continue;
    }

    if (line.indexOf(TYPE_SESSION) !== -1) {
      try {
        const ev = JSON.parse(line);
        if (ev?.type === 'session') {
          header = {
            id: typeof ev.id === 'string' ? ev.id : null,
            cwd: typeof ev.cwd === 'string' ? ev.cwd : null,
            createdAt: typeof ev.createdAt === 'number' ? ev.createdAt : null,
            agentPreset: typeof ev.agentPreset === 'string' ? ev.agentPreset : null,
          };
        }
      } catch {
        /* 同上 */
      }
    }
  }

  return { header, title, presented };
}

/** Windows 路径归一：统一反斜杠、去掉尾部多余分隔符。大小写保留原样用于展示。 */
export function normalizePath(p) {
  let s = String(p).trim();
  if (!s) return '';
  s = s.replace(/\//g, '\\');
  while (s.length > 1 && s.endsWith('\\')) s = s.slice(0, -1);
  return s;
}

/** 记录主键：归一化路径小写后取 sha1 前 16 位。Windows 文件系统大小写不敏感。 */
export function hashPath(normalizedPath) {
  return createHash('sha1').update(normalizedPath.toLowerCase()).digest('hex').slice(0, 16);
}

/** 本地时区 YYYY-MM-DD。日期维度按**最后一次交付**算（重复交付意味着内容变过）。 */
export function ymdLocal(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 扩展名（小写，不含点）。无扩展名返回 ''。 */
export function extOf(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return '';
  return name.slice(i + 1).toLowerCase();
}

/** 项目 slug（`--C-Users-98340-.dsh--`）→ 可读名字兜底。 */
function projectLabelFromSlug(slug) {
  const bare = slug.replace(/^-+/, '').replace(/-+$/, '');
  if (!bare) return slug;
  // slug 把路径分隔符换成了 `-`，还原不了原路径，只取最后一段做展示名
  const seg = bare.split('-').filter(Boolean);
  return seg.length ? seg[seg.length - 1] : bare;
}

/**
 * 扫全部会话日志，产出「会话 → present 记录」列表。
 *
 * @param {object} opts
 * @param {string} opts.sessionsRoot  `<DSH_HOME>/sessions`
 * @param {(p:{done:number,total:number,file:string})=>void} [opts.onProgress]
 * @param {()=>boolean} [opts.shouldStop]
 * @returns {Promise<{sessions:Array, stats:object}>}
 */
export async function scanAllSessions({ sessionsRoot, onProgress, shouldStop }) {
  const startedAt = Date.now();
  /** @type {Array} */
  const sessions = [];
  const stats = {
    projectDirs: 0,
    logFiles: 0,
    logBytes: 0,
    badLogs: 0,
    presentedEvents: 0,
    sessionsWithPresented: 0,
    elapsedMs: 0,
  };

  if (!existsSync(sessionsRoot)) {
    stats.elapsedMs = Date.now() - startedAt;
    return { sessions, stats };
  }

  let projectDirs = [];
  try {
    projectDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    stats.elapsedMs = Date.now() - startedAt;
    return { sessions, stats };
  }
  stats.projectDirs = projectDirs.length;

  // 先数一遍总文件数，好给进度一个准确分母
  const jobs = [];
  for (const project of projectDirs) {
    const projectDir = join(sessionsRoot, project);
    let entries = [];
    try {
      entries = readdirSync(projectDir, { withFileTypes: true }).filter((e) => e.isDirectory());
    } catch {
      continue;
    }
    for (const e of entries) {
      const logPath = join(projectDir, e.name, SESSION_LOG_NAME);
      if (!existsSync(logPath)) continue;
      jobs.push({ project, sessionId: e.name, logPath });
    }
  }
  stats.logFiles = jobs.length;

  let done = 0;
  for (const job of jobs) {
    if (shouldStop && shouldStop()) break;
    done += 1;

    let size = 0;
    try {
      size = statSync(job.logPath).size;
    } catch {
      stats.badLogs += 1;
      continue;
    }
    stats.logBytes += size;

    const text = readSessionText(job.logPath);
    if (!text) {
      stats.badLogs += 1;
      continue;
    }

    const { header, title, presented } = parseSessionText(text);
    if (presented.length) {
      stats.presentedEvents += presented.length;
      stats.sessionsWithPresented += 1;
      sessions.push({
        project: job.project,
        projectLabel: projectLabelFromSlug(job.project),
        sessionId: header?.id ?? job.sessionId,
        dirName: job.sessionId,
        cwd: header?.cwd ?? null,
        title: title ?? null,
        createdAt: header?.createdAt ?? null,
        presented,
      });
    }

    if (onProgress && (done % 25 === 0 || done === jobs.length)) {
      try {
        onProgress({ done, total: jobs.length, file: job.sessionId });
      } catch {
        /* 进度回调不该影响扫描 */
      }
    }

    // 让出事件循环：单份日志最大几十 MB，连续解压会让宿主明显卡顿
    await new Promise((r) => setImmediate(r));
  }

  stats.elapsedMs = Date.now() - startedAt;
  return { sessions, stats };
}

/**
 * 把「会话 → present 记录」归并成以文件为主体的记录表。
 *
 * 归并键是归一化路径（一个文件一条记录）；同一文件被多个会话、多次交付时
 * 累加计数、合并会话列表、去重保留描述。
 *
 * @param {Array} sessions scanAllSessions 的输出
 * @returns {Array} 记录数组（尚未做磁盘存在性检查、尚未打标签）
 */
export function aggregateRecords(sessions) {
  /** @type {Map<string, any>} */
  const map = new Map();

  for (const s of sessions) {
    for (const ev of s.presented) {
      for (const f of ev.files) {
        const path = normalizePath(f.path);
        if (!path) continue;
        const id = hashPath(path);
        const time = typeof ev.time === 'number' ? ev.time : s.createdAt ?? null;

        let rec = map.get(id);
        if (!rec) {
          const name = basename(path);
          rec = {
            id,
            path,
            name,
            dir: path.slice(0, Math.max(0, path.length - name.length - 1)) || '',
            ext: extOf(name),
            sizeBytes: null,
            mtimeMs: null,
            exists: false,
            checkedAt: null,
            firstPresentedAt: time,
            lastPresentedAt: time,
            presentCount: 0,
            descriptions: [],
            sessions: [],
            autoTags: null,
            userTags: { type: null, content: [], date: null },
          };
          map.set(id, rec);
        }

        rec.presentCount += 1;
        if (time != null) {
          if (rec.firstPresentedAt == null || time < rec.firstPresentedAt) rec.firstPresentedAt = time;
          if (rec.lastPresentedAt == null || time > rec.lastPresentedAt) rec.lastPresentedAt = time;
        }

        const desc = f.description.trim();
        if (desc && rec.descriptions.indexOf(desc) === -1 && rec.descriptions.length < 8) {
          rec.descriptions.push(desc);
        }

        // 会话列表：同一会话只留一条，记录它最后一次交付该文件的时间
        const existing = rec.sessions.find((x) => x.sessionId === s.sessionId);
        if (existing) {
          if (time != null && (existing.time == null || time > existing.time)) existing.time = time;
        } else {
          rec.sessions.push({
            sessionId: s.sessionId,
            project: s.project,
            projectLabel: s.projectLabel,
            cwd: s.cwd,
            title: s.title,
            time,
          });
        }
      }
    }
  }

  // 会话列表按时间倒序：详情里「最近一次来自哪」最有用
  const records = [...map.values()];
  for (const rec of records) {
    rec.sessions.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
  }
  records.sort((a, b) => (b.lastPresentedAt ?? 0) - (a.lastPresentedAt ?? 0));
  return records;
}

/**
 * 检查记录对应的文件此刻是否还在磁盘上，并刷新体积/修改时间。
 * 只做 lstat，不读内容 —— 144 条记录开销可忽略。
 *
 * @param {Array} records
 * @param {number} [now]
 */
export function checkExistence(records, now = Date.now()) {
  let existsCount = 0;
  let totalBytes = 0;
  for (const rec of records) {
    try {
      const st = statSync(rec.path);
      if (st.isFile()) {
        rec.exists = true;
        rec.sizeBytes = st.size;
        rec.mtimeMs = Math.round(st.mtimeMs);
        totalBytes += st.size;
        existsCount += 1;
      } else {
        rec.exists = false;
        rec.sizeBytes = null;
        rec.mtimeMs = null;
      }
    } catch {
      rec.exists = false;
      rec.sizeBytes = null;
      rec.mtimeMs = null;
    }
    rec.checkedAt = now;
  }
  return { existsCount, missingCount: records.length - existsCount, totalBytes };
}

/** 把记录表压成可下发的摘要（去掉可能很大的字段，列表页不需要）。 */
export function summarizeRecord(rec) {
  return {
    id: rec.id,
    path: rec.path,
    name: rec.name,
    dir: rec.dir,
    ext: rec.ext,
    sizeBytes: rec.sizeBytes,
    exists: rec.exists,
    firstPresentedAt: rec.firstPresentedAt,
    lastPresentedAt: rec.lastPresentedAt,
    presentCount: rec.presentCount,
    description: rec.descriptions?.[0] ?? '',
    sessions: (rec.sessions ?? []).map((s) => ({
      sessionId: s.sessionId,
      projectLabel: s.projectLabel,
      title: s.title,
      time: s.time,
    })),
    autoTags: rec.autoTags,
    userTags: rec.userTags,
  };
}

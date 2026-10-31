/**
 * 标签提取 —— 三个维度里「内容标签」的自动来源。
 *
 * 分两层：
 *   L1 本地解析：直接从文件里取标题（md 的一级标题 / html 的 title / txt 首行 / csv 表头…）
 *   L0 交付说明：`present` 事件的 description 是模型写的中文一句话，天然就是内容摘要
 *
 * 两层产出的都是**自由文本**，再用下面的规则词表归一化成有限标签集。
 * 归一化是必须的：144 条记录如果每条标签都独一无二，筛选就没有意义。
 *
 * 图片（png/jpg）与 PDF **不做本地解析** —— 内核没有宿主侧 PDF 文本抽取，
 * 图片更不可能，这两类只靠 L0 的 description。这也是实测口径里「48 条需要模型、
 * 91 条可本地解析」的来源；但既然 present 一定有 description，L3 模型补标签
 * 在本机基本用不上，做成默认关闭的按钮即可。
 */

import { openSync, readSync, closeSync, statSync } from 'node:fs';

/** 只读文件头，最多 256 KB —— 取标题足够了，也避免把大日志读进内存。 */
const HEAD_BYTES = 256 * 1024;

/** 按扩展名归类。前端「文件类型」筛选就用这里的 key。 */
export const TYPE_CATEGORIES = {
  doc: { label: '文档', exts: ['md', 'txt', 'log', 'text', 'rtf', 'doc', 'docx', 'odt', 'markdown'] },
  web: { label: '网页', exts: ['html', 'htm', 'xhtml', 'mhtml'] },
  image: { label: '图片', exts: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'ico', 'svg'] },
  pdf: { label: 'PDF', exts: ['pdf'] },
  sheet: { label: '表格', exts: ['csv', 'tsv', 'xlsx', 'xls', 'ods'] },
  data: { label: '数据', exts: ['json', 'jsonl', 'yaml', 'yml', 'xml', 'toml', 'ini'] },
  code: { label: '代码', exts: ['js', 'mjs', 'cjs', 'ts', 'py', 'ps1', 'cmd', 'bat', 'sh', 'java', 'php', 'go', 'rs', 'c', 'cpp', 'h', 'sql'] },
  archive: { label: '压缩包', exts: ['zip', 'tgz', 'gz', 'tar', '7z', 'rar'] },
  app: { label: '程序/快捷方式', exts: ['exe', 'lnk', 'msi', 'app', 'url'] },
  other: { label: '其它', exts: [] },
};

const EXT_TO_TYPE = (() => {
  const m = new Map();
  for (const [key, def] of Object.entries(TYPE_CATEGORIES)) {
    for (const ext of def.exts) m.set(ext, key);
  }
  return m;
})();

/** 扩展名 → 类型 key。未知扩展名归 other。 */
export function typeOfExt(ext) {
  return EXT_TO_TYPE.get(String(ext ?? '').toLowerCase()) ?? 'other';
}

/** 类型 key → 中文标签。 */
export function typeLabel(typeKey) {
  return TYPE_CATEGORIES[typeKey]?.label ?? '其它';
}

/** 这些类型不读内容（二进制 / 无文本层）。 */
const NO_LOCAL_READ = new Set(['image', 'pdf', 'sheet', 'archive', 'app']);

/** svg 虽然归在 image，但它是文本，可以读。 */
function canReadLocally(ext, typeKey) {
  if (ext === 'svg') return true;
  return !NO_LOCAL_READ.has(typeKey);
}

/**
 * 从文件里取一个「标题」形式的内容线索。
 * @param {string} filePath
 * @param {string} ext
 * @returns {{title:string|null, ok:boolean, reason?:string}}
 */
export function extractLocalTitle(filePath, ext) {
  const typeKey = typeOfExt(ext);
  if (!canReadLocally(ext, typeKey)) {
    return { title: null, ok: false, reason: 'binary-or-no-text-layer' };
  }
  let text;
  try {
    const st = statSync(filePath);
    if (!st.isFile()) return { title: null, ok: false, reason: 'not-a-file' };
    const len = Math.min(st.size, HEAD_BYTES);
    const buf = Buffer.alloc(len);
    const fd = openSync(filePath, 'r');
    try {
      readSync(fd, buf, 0, len, 0);
    } finally {
      closeSync(fd);
    }
    text = buf.toString('utf8');
    // 去掉 UTF-8 BOM
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  } catch (err) {
    return { title: null, ok: false, reason: err?.code ?? 'read-error' };
  }

  const title = pickTitle(text, ext, typeKey);
  return { title, ok: title != null, reason: title ? undefined : 'no-title-found' };
}

function firstMeaningfulLine(text, maxLen = 120) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^(---|===|\+\+\+|\*\*\*)$/.test(line)) continue;
    return line.slice(0, maxLen);
  }
  return null;
}

function pickTitle(text, ext, typeKey) {
  switch (ext) {
    case 'md':
    case 'markdown': {
      // 一级标题优先
      const h1 = /^#\s+(.+)$/m.exec(text);
      if (h1) return h1[1].trim().slice(0, 120);
      const h2 = /^##\s+(.+)$/m.exec(text);
      if (h2) return h2[1].trim().slice(0, 120);
      return firstMeaningfulLine(text);
    }
    case 'html':
    case 'htm':
    case 'xhtml': {
      const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
      if (t && t[1].trim()) return decodeEntities(t[1].trim()).slice(0, 120);
      const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text);
      if (h1) return stripTags(h1[1]).slice(0, 120);
      return null;
    }
    case 'svg': {
      const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
      if (t && t[1].trim()) return decodeEntities(t[1].trim()).slice(0, 120);
      return null;
    }
    case 'csv':
    case 'tsv': {
      const line = firstMeaningfulLine(text, 200);
      return line ? line.replace(/[,\t]/g, ' / ').slice(0, 120) : null;
    }
    case 'json': {
      const name = /"(?:title|name|description)"\s*:\s*"([^"]{2,120})"/.exec(text);
      if (name) return name[1];
      return firstMeaningfulLine(text, 80);
    }
    case 'log':
    case 'txt':
    case 'text':
    default:
      return firstMeaningfulLine(text, 120);
  }
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function decodeEntities(s) {
  return stripTags(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * 内容标签规则表。
 *
 * 顺序即优先级：**领域主题在前、文档类型在后**，因为筛选时「这是量化交易的」
 * 比「这是报告」更有区分度。每条规则命中即产生一个标签，同一标签只出一次。
 *
 * 词表来自本机 144 条真实交付语料（`reports/corpus.txt`）的归纳，不是凭空写的。
 */
const CONTENT_RULES = [
  // ── 领域 / 主题 ──────────────────────────────────────────
  [/量化交易|做[tT]\b|做T|台账|成交记录|自选股|持仓|行情/, '量化交易'],
  [/仪表盘|看板|活力图|热力/, '仪表盘'],
  [/飞书|lark/i, '飞书'],
  [/明道云|HAP\b/i, '明道云'],
  [/多维表格|bitable/i, '多维表格'],
  [/SHEIN|希音/i, 'SHEIN 接口'],
  [/WebDAV|绿联|NAS\b/i, 'NAS/WebDAV'],
  [/知识库|衣云|kb\b/i, '知识库'],
  [/技能|skill/i, '技能'],
  [/备份|同步/, '备份同步'],
  [/手机远程|配对|二维码|Whaleness|移动网关|overlay|节点小宝/i, '手机接入'],
  [/WSL|Ubuntu|子系统/i, 'WSL'],
  [/插件|plugin/i, 'DSH 插件'],
  [/提示词|prompt/i, '提示词'],
  [/DeepSeek Harness|DSH 内核|DSH 本体|DSH 版本|Harness 版本/, 'DSH 本体'],
  [/发票|invoice/i, '发票'],
  [/安装包|安装程序|setup\b/i, '安装包'],
  [/更新日志|changelog/i, '更新日志'],
  [/动画|矢量|图形|海报|插画|svg/i, '图形/动画'],
  [/Codex|ChatGPT/i, 'Codex'],
  [/Claude|Anthropic/i, 'Claude'],
  [/MCP\b|mcp 服务/i, 'MCP'],
  [/浏览器|Chrome|CDP|Playwright/i, '浏览器自动化'],
  [/OCR|识别|截图导入|截图录入/i, '图像识别'],
  [/模型|LLM|token|推理/i, '模型调用'],
  [/磁盘|清理|空间|C 盘|C盘/i, '磁盘清理'],

  // ── 文档类型 / 形态 ─────────────────────────────────────
  [/交付报告|排查报告|分析报告|测试报告|报告/, '报告'],
  [/说明|指南|手册|文档|教程|接入方法/, '说明文档'],
  [/清单|列表|总表/, '清单'],
  [/设计|口径|方案/, '设计'],
  [/预览|样张|可交互/, '预览'],
  [/验收|验证|实拍|断言/, '验收'],
  [/修复|排错|排查|根因|bug/i, '修复排查'],
  [/升级|迁移|换机/, '升级迁移'],
  [/截图|实拍|shots?\b|tooltip/i, '截图'],
];

/** 单条记录最多保留多少个内容标签 —— chip 太多反而看不出重点。 */
const MAX_CONTENT_TAGS = 10;

/**
 * 从一段或多段文本里匹配内容标签。
 * @param {string[]} texts
 * @returns {string[]}
 */
export function matchContentTags(texts) {
  const haystack = texts.filter(Boolean).join(' \n ');
  if (!haystack) return [];
  const tags = [];
  for (const [re, tag] of CONTENT_RULES) {
    if (tags.length >= MAX_CONTENT_TAGS) break;
    if (tags.indexOf(tag) !== -1) continue;
    if (re.test(haystack)) tags.push(tag);
  }
  return tags;
}

/**
 * 给一条记录打自动标签。
 *
 * 注意 `autoTags` 与 `userTags` 严格分离：用户改过的标签写进 `userTags`，
 * 本函数永远只写 `autoTags`。重扫时若 `contentHash` 没变就跳过，
 * 既省 IO 也保证「用户手动改过的」不会被自动结果悄悄覆盖。
 *
 * @param {object} rec indexer 产出的记录
 * @param {object} [opts]
 * @param {boolean} [opts.readContent=true] 是否允许读文件内容（离线批量时关掉可提速）
 * @returns {object} autoTags
 */
export function buildAutoTags(rec, opts = {}) {
  const readContent = opts.readContent !== false;
  const typeKey = typeOfExt(rec.ext);
  const sources = [];

  /** @type {string[]} */
  const texts = [rec.name ?? ''];

  let localTitle = null;
  if (readContent && rec.exists && canReadLocally(rec.ext, typeKey)) {
    const got = extractLocalTitle(rec.path, rec.ext);
    if (got.ok && got.title) {
      localTitle = got.title;
      texts.push(got.title);
      sources.push('content');
    }
  }

  const descriptions = Array.isArray(rec.descriptions) ? rec.descriptions : [];
  if (descriptions.length) {
    texts.push(...descriptions);
    sources.push('description');
  }

  const content = matchContentTags(texts);

  return {
    type: typeKey,
    content,
    localTitle,
    sources,
    extractedAt: Date.now(),
    // 内容指纹：描述 + 文件 mtime/size，用来判断是否需要重算
    contentHash: contentHashOf(rec, localTitle),
  };
}

function contentHashOf(rec, localTitle) {
  const parts = [
    rec.ext ?? '',
    rec.sizeBytes ?? '',
    rec.mtimeMs ?? '',
    localTitle ?? '',
    ...(rec.descriptions ?? []),
  ].join('|');
  // 简单的 32 位 FNV-1a，够用来做「变没变」的判断，不必上 sha
  let h = 0x811c9dc5;
  for (let i = 0; i < parts.length; i++) {
    h ^= parts.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 展示用的三维取值：用户覆盖优先，自动结果兜底。
 * 返回 `{type, content, date}` —— date 是本地时区 YYYY-MM-DD。
 *
 * @param {object} rec
 * @param {(ms:number)=>string|null} ymd 日期格式化函数（由调用方注入，避免循环依赖）
 */
export function effectiveTags(rec, ymd) {
  const auto = rec.autoTags ?? {};
  const user = rec.userTags ?? {};
  const typeKey = user.type || auto.type || typeOfExt(rec.ext);
  const content = Array.isArray(user.content) && user.content.length ? user.content : auto.content ?? [];
  const date = user.date || ymd(rec.lastPresentedAt) || null;
  return { type: typeKey, typeLabel: typeLabel(typeKey), content, date };
}

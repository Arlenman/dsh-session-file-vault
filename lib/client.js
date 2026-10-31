window.__ModuleLoader__.load({
  id: 'dsh-session-file-vault',
  factory: (require) => {
    'use strict';

    const React = require('react');
    const h = React.createElement;

    /* ============================================================ 常量 */

    const PANEL_ID = 'dsh-session-file-vault';
    const SIDEBAR_ORDER = 50;
    const API = '/api/session-file-vault';
    const STYLE_ID = 'dsh-session-file-vault-style';
    const LABEL = '文件库';

    /** 数据类型 → 图标（用字符，免引入图标库；内核种子表里没有图标包）。 */
    const TYPE_ICON = {
      doc: '📄',
      image: '🖼️',
      web: '🌐',
      pdf: '📕',
      sheet: '📊',
      data: '🗄️',
      code: '⌨️',
      archive: '📦',
      app: '⚙️',
      other: '📁',
    };

    const SORT_MODES = [
      ['recent', '最近交付'],
      ['name', '名称'],
      ['size', '体积'],
      ['count', '交付次数'],
    ];

    /* ============================================================ 工具 */

    function fmtSize(bytes) {
      if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '—';
      if (bytes < 1024) return bytes + ' B';
      const units = ['KB', 'MB', 'GB', 'TB'];
      let v = bytes / 1024;
      let i = 0;
      while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i += 1;
      }
      return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
    }

    function pad2(n) {
      return n < 10 ? '0' + n : '' + n;
    }

    /** 毫秒 → 本地 YYYY-MM-DD。 */
    function ymdOf(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '';
      const d = new Date(ms);
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }

    /** 毫秒 → 「10-30 19:48」这种紧凑本地时间。 */
    function hmOf(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—';
      const d = new Date(ms);
      return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }

    /** 「3 天前」这种相对时间，超过 60 天回落到日期。 */
    function relOf(ms, nowMs) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '—';
      const diff = nowMs - ms;
      if (diff < 0) return '刚刚';
      const min = Math.floor(diff / 60000);
      if (min < 1) return '刚刚';
      if (min < 60) return min + ' 分钟前';
      const hour = Math.floor(min / 60);
      if (hour < 24) return hour + ' 小时前';
      const day = Math.floor(hour / 24);
      if (day < 60) return day + ' 天前';
      return ymdOf(ms);
    }

    /** 目录缩写：只留最后两段，前面用 … */
    function shortDir(dir) {
      if (!dir) return '';
      const parts = String(dir).split(/[\\/]+/).filter(Boolean);
      if (parts.length <= 2) return String(dir);
      return '…' + (dir.indexOf('\\') >= 0 ? '\\' : '/') + parts.slice(-2).join(dir.indexOf('\\') >= 0 ? '\\' : '/');
    }

    /**
     * 具体时间：{md:'10-31', hm:'19:48', full:'2026-10-31 19:48'}。
     * 列表左侧时间轴用 md+hm 两行显示，title 里给 full。
     */
    function stampOf(ms) {
      if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return { md: '—', hm: '—', full: '—' };
      const d = new Date(ms);
      const md = pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      const hm = pad2(d.getHours()) + ':' + pad2(d.getMinutes());
      return {
        md: md,
        hm: hm,
        full: d.getFullYear() + '-' + md + ' ' + hm,
      };
    }

    /** FNV-1a：同一段文本永远同一个色相（0–359），跨刷新稳定。 */
    function hueOf(text) {
      const s = String(text == null ? '' : text);
      let hsh = 2166136261;
      for (let i = 0; i < s.length; i += 1) {
        hsh ^= s.charCodeAt(i);
        hsh = (hsh * 16777619) >>> 0;
      }
      return hsh % 360;
    }

    /** 内容标签底色：只给半透明背景，文字色交给 CSS 继承 —— 浅色/深色主题都成立。 */
    function tagStyle(tag) {
      return { background: 'hsla(' + hueOf(tag) + ', 70%, 52%, .17)' };
    }

    /** 文件类型固定色相（同一类永远同一色，便于扫读）。 */
    const TYPE_HUE = {
      doc: 215,
      web: 190,
      image: 285,
      pdf: 0,
      sheet: 145,
      data: 175,
      code: 35,
      archive: 265,
      app: 95,
      other: 220,
    };

    function typeStyle(type) {
      const hue = TYPE_HUE[type] == null ? TYPE_HUE.other : TYPE_HUE[type];
      return { background: 'hsla(' + hue + ', 68%, 50%, .20)' };
    }

    /** 每行列数：1 / 2 / 3，存 localStorage（读不到就是 1 列）。 */
    const COLS_KEY = 'dsh-session-file-vault:cols';
    const COLS_ALLOWED = [1, 2, 3];

    function readCols() {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return 1;
        const n = parseInt(window.localStorage.getItem(COLS_KEY), 10);
        return COLS_ALLOWED.indexOf(n) >= 0 ? n : 1;
      } catch (e) {
        return 1;
      }
    }

    function writeCols(n) {
      try {
        if (typeof window === 'undefined' || !window.localStorage) return;
        window.localStorage.setItem(COLS_KEY, String(n));
      } catch (e) {
        /* 隐私模式下写不进去，忽略即可 */
      }
    }

    /** 同步范围的文案（设置弹窗与提示里共用）。 */
    const SYNC_MODE_TEXT = {
      all: '全部文件',
      type: '按类型',
      manual: '手动收藏',
    };

    function uniq(arr) {
      const seen = new Set();
      const out = [];
      for (const v of arr) {
        if (seen.has(v)) continue;
        seen.add(v);
        out.push(v);
      }
      return out;
    }

    function includesLoose(haystack, needle) {
      return String(haystack || '').toLowerCase().indexOf(needle) >= 0;
    }

    /* ============================================================ HTTP */

    async function readJson(res) {
      let text = '';
      try {
        text = await res.text();
      } catch (e) {
        throw new Error('读取响应失败：' + (e && e.message ? e.message : e));
      }
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (e) {
          throw new Error('响应不是合法 JSON（HTTP ' + res.status + '）');
        }
      }
      if (!res.ok) {
        const msg = data && data.error && data.error.message ? data.error.message : 'HTTP ' + res.status;
        const err = new Error(msg);
        err.status = res.status;
        err.code = data && data.error && data.error.code ? data.error.code : null;
        throw err;
      }
      return data || {};
    }

    async function apiGet(path) {
      const res = await fetch(API + path, { cache: 'no-store', credentials: 'same-origin' });
      return readJson(res);
    }

    async function apiPost(path, body) {
      const res = await fetch(API + path, {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      return readJson(res);
    }

    /* ============================================================ 样式 */

    const CSS = `
.sfv-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 13px;
  line-height: 1.5;
  color: inherit;
  background: transparent;
}
.sfv-root * { box-sizing: border-box; }

/* ---- 顶部 ---- */
.sfv-head {
  flex: none;
  border-bottom: 1px solid rgba(128,128,128,.24);
  padding: 10px 14px 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.sfv-head-row { display: flex; align-items: center; gap: 8px; min-height: 24px; }
.sfv-title { font-size: 14px; font-weight: 600; letter-spacing: .2px; }
.sfv-sub { font-size: 12px; opacity: .62; }
.sfv-spacer { flex: 1 1 auto; }

.sfv-btn {
  font: inherit;
  font-size: 12px;
  color: inherit;
  background: transparent;
  border: 1px solid rgba(128,128,128,.38);
  border-radius: 6px;
  padding: 3px 10px;
  cursor: pointer;
  white-space: nowrap;
}
.sfv-btn:hover { background: rgba(128,128,128,.14); }
.sfv-btn:disabled { opacity: .45; cursor: default; }
.sfv-btn:disabled:hover { background: transparent; }
.sfv-btn.sfv-primary { border-color: rgba(59,130,246,.65); color: #3b82f6; }
.sfv-btn.sfv-primary:hover { background: rgba(59,130,246,.12); }
.sfv-btn.sfv-on { background: rgba(59,130,246,.16); border-color: rgba(59,130,246,.6); color: #3b82f6; }

/* ---- 搜索行 ---- */
.sfv-search-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sfv-search {
  flex: 1 1 220px;
  min-width: 150px;
  font: inherit;
  font-size: 13px;
  color: inherit;
  background: rgba(128,128,128,.10);
  border: 1px solid rgba(128,128,128,.3);
  border-radius: 7px;
  padding: 5px 9px;
  outline: none;
}
.sfv-search:focus { border-color: rgba(59,130,246,.7); background: rgba(128,128,128,.06); }
.sfv-search::placeholder { color: rgba(128,128,128,.85); }
.sfv-date {
  font: inherit;
  font-size: 12px;
  color: inherit;
  background: rgba(128,128,128,.10);
  border: 1px solid rgba(128,128,128,.3);
  border-radius: 7px;
  padding: 4px 6px;
  outline: none;
  color-scheme: light dark;
}
.sfv-date-sep { font-size: 12px; opacity: .5; }

/* ---- 类型 chips ---- */
.sfv-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.sfv-chip {
  font: inherit;
  font-size: 12px;
  color: inherit;
  background: rgba(128,128,128,.10);
  border: 1px solid rgba(128,128,128,.3);
  border-radius: 999px;
  padding: 2px 9px;
  cursor: pointer;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.sfv-chip:hover { background: rgba(128,128,128,.2); }
.sfv-chip.sfv-on {
  background: rgba(59,130,246,.18);
  border-color: rgba(59,130,246,.62);
  color: #3b82f6;
  font-weight: 500;
}
.sfv-chip-n { opacity: .55; font-size: 11px; }
.sfv-chip.sfv-ghost { border-style: dashed; opacity: .8; }

/* ---- 标签多选 ---- */
.sfv-tagbar { display: flex; align-items: flex-start; gap: 8px; }
.sfv-tagpick { position: relative; flex: 0 0 auto; }
.sfv-tagpick .sfv-search { width: 190px; flex: none; }
.sfv-tagdrop {
  position: absolute;
  z-index: 30;
  top: calc(100% + 4px);
  left: 0;
  min-width: 230px;
  max-height: 264px;
  overflow: auto;
  background: var(--dsh-popover-bg, #fff);
  color: var(--dsh-popover-fg, #1f2328);
  border: 1px solid rgba(128,128,128,.35);
  border-radius: 8px;
  box-shadow: 0 8px 26px rgba(0,0,0,.22);
  padding: 4px;
}
@media (prefers-color-scheme: dark) {
  .sfv-tagdrop { background: #22262c; color: #e6e8ea; }
}
.sfv-tagitem {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  font-size: 12.5px;
  white-space: nowrap;
}
.sfv-tagitem:hover { background: rgba(128,128,128,.18); }
.sfv-tagitem.sfv-on { color: #3b82f6; font-weight: 500; }
.sfv-tagitem-n { margin-left: auto; opacity: .5; font-size: 11px; }
.sfv-tagempty { padding: 8px 10px; opacity: .6; font-size: 12px; }
.sfv-sel { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; min-height: 22px; }
.sfv-selchip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  background: rgba(59,130,246,.16);
  border: 1px solid rgba(59,130,246,.5);
  color: #3b82f6;
  border-radius: 999px;
  padding: 1px 8px;
  cursor: pointer;
}
.sfv-selchip:hover { background: rgba(59,130,246,.28); }
.sfv-selchip-x { opacity: .7; font-size: 11px; }
.sfv-hint { font-size: 11.5px; opacity: .5; }

/* ---- 列表 ---- */
.sfv-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 6px 8px 24px; }
.sfv-list { list-style: none; margin: 0; padding: 0; }
.sfv-row {
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 6px 8px;
  cursor: pointer;
  display: flex;
  gap: 9px;
  align-items: flex-start;
}
.sfv-row:hover { background: rgba(128,128,128,.10); }
.sfv-row.sfv-open { background: rgba(59,130,246,.08); border-color: rgba(59,130,246,.32); }
.sfv-row-ico { flex: none; width: 20px; text-align: center; font-size: 15px; line-height: 20px; }
.sfv-row-main { flex: 1 1 auto; min-width: 0; }
.sfv-row-l1 { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.sfv-name {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.sfv-name.sfv-gone { text-decoration: line-through; opacity: .55; }
.sfv-row-meta { margin-left: auto; flex: none; font-size: 11.5px; opacity: .55; white-space: nowrap; }
.sfv-row-l2 { display: flex; align-items: center; gap: 6px; margin-top: 2px; flex-wrap: wrap; }
.sfv-tag {
  font-size: 11px;
  background: rgba(128,128,128,.14);
  border-radius: 4px;
  padding: 0 5px;
  opacity: .9;
  white-space: nowrap;
}
.sfv-tag.sfv-manual { box-shadow: inset 0 0 0 1px rgba(245,158,11,.75); }
.sfv-badge-miss { font-size: 11px; color: #ef4444; border: 1px solid rgba(239,68,68,.45); border-radius: 4px; padding: 0 5px; }
.sfv-badge-n { font-size: 11px; opacity: .5; }

/* ---- 分列（1 / 2 / 3 列；窄屏自动降级） ---- */
.sfv-list {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  column-gap: 10px;
  align-items: start;
}
.sfv-list.sfv-cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.sfv-list.sfv-cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
@media (max-width: 980px) {
  .sfv-list.sfv-cols-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 640px) {
  .sfv-list.sfv-cols-2,
  .sfv-list.sfv-cols-3 { grid-template-columns: minmax(0, 1fr); }
}

/* ---- 时间轴（左侧具体时间 + 竖线 + 节点） ---- */
.sfv-tl { position: relative; display: flex; align-items: flex-start; gap: 4px; }
.sfv-tl::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(128,128,128,.26);
}
.sfv-tl:first-child::before { top: 13px; }
.sfv-tl:last-child::before { bottom: auto; height: 13px; }
.sfv-tl-dot {
  position: absolute;
  left: 1px;
  top: 11px;
  width: 9px;
  height: 9px;
  box-sizing: border-box;
  border-radius: 50%;
  border: 2px solid rgba(59,130,246,.8);
  background: var(--dsh-bg, #fff);
}
.sfv-tl-when {
  flex: 0 0 56px;
  padding: 7px 0 0 16px;
  line-height: 1.3;
  font-variant-numeric: tabular-nums;
  user-select: none;
}
.sfv-tl-when b { display: block; font-size: 11.5px; font-weight: 600; opacity: .78; }
.sfv-tl-when span { display: block; font-size: 11px; opacity: .5; }
.sfv-tl-card { flex: 1 1 auto; min-width: 0; }
.sfv-list.sfv-cols-2 .sfv-tl::before,
.sfv-list.sfv-cols-3 .sfv-tl::before { display: none; }

/* ---- 收藏爱心（手动同步模式） ---- */
.sfv-heart {
  flex: none;
  width: 20px;
  height: 20px;
  padding: 0;
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  text-align: center;
  border-radius: 50%;
  border: 1px solid rgba(128,128,128,.45);
  background: transparent;
  color: rgba(128,128,128,.9);
  cursor: pointer;
}
.sfv-heart:hover { border-color: rgba(239,68,68,.75); color: #ef4444; }
.sfv-heart.sfv-on {
  background: #ef4444;
  border-color: #ef4444;
  color: #fff;
}
.sfv-heart.sfv-on:hover { background: #dc2626; }

/* ---- 设置弹窗 ---- */
.sfv-mask {
  position: fixed;
  inset: 0;
  z-index: 90;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0,0,0,.42);
  padding: 16px;
}
.sfv-modal {
  width: min(580px, 100%);
  max-height: min(84vh, 720px);
  overflow: auto;
  background: var(--dsh-popover-bg, #fff);
  color: var(--dsh-popover-fg, #1f2328);
  border: 1px solid rgba(128,128,128,.28);
  border-radius: 12px;
  box-shadow: 0 24px 60px rgba(0,0,0,.35);
  padding: 16px 18px 14px;
}
@media (prefers-color-scheme: dark) {
  .sfv-modal { background: #22262c; color: #e6e8ea; }
}
.sfv-modal-t { font-size: 15px; font-weight: 600; margin: 0 0 2px; }
.sfv-modal-s { font-size: 12px; opacity: .58; margin: 0 0 12px; }
.sfv-field { margin: 0 0 14px; }
.sfv-field-k { font-size: 12.5px; font-weight: 500; margin: 0 0 5px; }
.sfv-field-hint { font-size: 11.5px; opacity: .55; margin-top: 4px; line-height: 1.45; }
.sfv-dir-row { display: flex; gap: 6px; }
.sfv-dir-row .sfv-search { flex: 1 1 auto; width: auto; min-width: 0; }
.sfv-radio-row { display: flex; flex-wrap: wrap; gap: 6px; }
.sfv-modal-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding-top: 12px;
  border-top: 1px solid rgba(128,128,128,.22);
}
.sfv-modal-foot .sfv-spacer { flex: 1 1 auto; }
.sfv-sync-res { font-size: 12px; line-height: 1.55; opacity: .8; }
.sfv-sync-res b { font-weight: 600; }

/* ---- 展开详情 ---- */
.sfv-detail {
  margin: 4px 0 8px 29px;
  border-left: 2px solid rgba(59,130,246,.34);
  padding: 4px 0 4px 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12.5px;
}
.sfv-kv { display: flex; gap: 8px; align-items: flex-start; }
.sfv-kv-k { flex: 0 0 52px; opacity: .55; }
.sfv-kv-v { flex: 1 1 auto; min-width: 0; word-break: break-all; }
.sfv-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; }
.sfv-sect { margin-top: 2px; }
.sfv-sect-t { font-size: 11.5px; opacity: .55; margin-bottom: 2px; }
.sfv-desc { display: flex; gap: 6px; align-items: baseline; }
.sfv-desc-t { flex: none; font-size: 11px; opacity: .45; }
.sfv-sess {
  display: flex;
  gap: 6px;
  align-items: baseline;
  padding: 1px 0;
}
.sfv-sess-t { flex: none; font-size: 11px; opacity: .45; width: 74px; }
.sfv-sess-n { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sfv-sess-p { flex: none; font-size: 11px; opacity: .5; max-width: 34%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ---- 状态 ---- */
.sfv-center { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 48px 16px; text-align: center; }
.sfv-center-t { font-size: 13px; opacity: .8; }
.sfv-center-s { font-size: 12px; opacity: .55; max-width: 380px; }
.sfv-err { color: #ef4444; }
.sfv-progress {
  width: 240px;
  height: 4px;
  border-radius: 2px;
  background: rgba(128,128,128,.22);
  overflow: hidden;
}
.sfv-progress-i { height: 100%; background: #3b82f6; transition: width .25s linear; }
.sfv-notice {
  margin: 0 14px 6px;
  border-radius: 7px;
  padding: 5px 9px;
  font-size: 12px;
  background: rgba(245,158,11,.14);
  border: 1px solid rgba(245,158,11,.4);
}

/* ---- 视图切换 ---- */
.sfv-viewswitch {
  display: inline-flex;
  border: 1px solid rgba(128,128,128,.28);
  border-radius: 7px;
  overflow: hidden;
}
.sfv-viewswitch button {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  opacity: .6;
}
.sfv-viewswitch button.sfv-on { background: rgba(59,130,246,.16); opacity: 1; }

/* ---- 脑图 ---- */
.sfv-graphbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 14px 8px;
  font-size: 12px;
}
.sfv-graphbar-t { opacity: .55; }
.sfv-graphbar .sfv-spacer { flex: 1 1 auto; }
.sfv-graph-wrap {
  position: relative;
  margin: 2px 6px 16px;
  height: clamp(340px, 62vh, 780px);
  overflow: hidden;
  border: 1px solid rgba(128,128,128,.20);
  border-radius: 10px;
  background: radial-gradient(circle at 50% 45%, rgba(59,130,246,.06), transparent 62%);
  cursor: grab;
  touch-action: none;
  user-select: none;
}
.sfv-graph-wrap:active { cursor: grabbing; }
.sfv-graph { display: block; width: 100%; height: 100%; }
.sfv-gzoom { display: inline-flex; align-items: center; gap: 2px; }
.sfv-gzoom button {
  appearance: none;
  border: 1px solid rgba(128,128,128,.28);
  background: transparent;
  color: inherit;
  cursor: pointer;
  font: inherit;
  font-size: 11.5px;
  line-height: 1;
  padding: 3px 7px;
  border-radius: 6px;
  opacity: .7;
}
.sfv-gzoom button:hover { opacity: 1; background: rgba(59,130,246,.12); }
.sfv-gzoom .sfv-gzoom-k { min-width: 46px; font-variant-numeric: tabular-nums; }
.sfv-gedge { stroke: rgba(128,128,128,.28); stroke-width: 1; fill: none; }
.sfv-gedge.sfv-hot { stroke: rgba(59,130,246,.75); stroke-width: 1.6; }
.sfv-gdim circle {
  fill: rgba(59,130,246,.16);
  stroke: rgba(59,130,246,.62);
  stroke-width: 1.4;
  cursor: pointer;
}
.sfv-gdim:hover circle { fill: rgba(59,130,246,.30); }
.sfv-gdim.sfv-sel circle { fill: rgba(59,130,246,.42); stroke: rgba(59,130,246,1); }
.sfv-gdim text { font-size: 12px; fill: currentColor; cursor: pointer; }
.sfv-gdim .sfv-gdim-c { font-size: 10.5px; opacity: .55; }
.sfv-gfile circle {
  fill: rgba(148,163,184,.42);
  stroke: rgba(148,163,184,.72);
  stroke-width: .8;
  cursor: pointer;
}
.sfv-gfile:hover circle { fill: rgba(59,130,246,.82); stroke: rgba(59,130,246,1); }
.sfv-gfile.sfv-miss circle { fill: rgba(239,68,68,.32); stroke: rgba(239,68,68,.72); }
.sfv-gfile.sfv-sel circle { fill: rgba(59,130,246,.92); stroke: #fff; }
.sfv-graph-empty { padding: 44px 16px; text-align: center; font-size: 12.5px; opacity: .6; }
`;

    /**
     * 注入（或热更新）样式。HMR 会重跑整个 bundle，但旧 <style> 还留在 DOM 里，
     * 所以不能「有就跳过」；同时清掉可能残留的重复节点。
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      const head = document.head || document.documentElement;
      if (!head) return;
      let tag = document.getElementById(STYLE_ID);
      if (!tag) {
        tag = document.createElement('style');
        tag.id = STYLE_ID;
        head.appendChild(tag);
      }
      // 注意：不能在「新建」分支里跳过写入 —— 首次注入时标签必然是空的，
      // 只有「已存在」分支才写会让新加载的页面永远拿到 0 字节样式表。
      if (tag.textContent !== CSS) tag.textContent = CSS;
      // 清理历史重复节点（同 id 只该有一个生效）
      const all = document.querySelectorAll('style[id="' + STYLE_ID + '"]');
      for (let i = 1; i < all.length; i += 1) {
        const node = all[i];
        if (node.parentNode) node.parentNode.removeChild(node);
      }
    }

    /* ============================================================ 侧边栏图标 */

    function SidebarIcon(props) {
      const size = (props && props.size) || 18;
      const active = Boolean(props && props.active);
      const svgProps = {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        style: { opacity: active ? 1 : 0.78 },
        'aria-hidden': 'true',
      };
      return h(
        'svg',
        svgProps,
        // 三层抽屉（类型 / 标签 / 日期）
        h('path', { key: 'a', d: 'M3 6.5h18' }),
        h('path', { key: 'b', d: 'M3 12h18' }),
        h('path', { key: 'c', d: 'M3 17.5h11' }),
        h('path', { key: 'd', d: 'M17.5 15.5v4' }),
        h('path', { key: 'e', d: 'M15.5 17.5h4' }),
      );
    }

    /* ============================================================ 筛选：类型 */

    function TypeChips(props) {
      const cats = props.categories || [];
      const counts = props.counts || {};
      const value = props.value || '';
      const children = [
        h(
          'button',
          {
            key: '__all__',
            type: 'button',
            className: 'sfv-chip' + (value === '' ? ' sfv-on' : ''),
            onClick: () => props.onChange(''),
            title: '不按类型筛选',
          },
          '全部',
          h('span', { className: 'sfv-chip-n' }, String(props.total || 0)),
        ),
      ];
      for (const cat of cats) {
        const n = counts[cat.key] || 0;
        if (n === 0) continue;
        children.push(
          h(
            'button',
            {
              key: cat.key,
              type: 'button',
              className: 'sfv-chip' + (value === cat.key ? ' sfv-on' : ''),
              onClick: () => props.onChange(value === cat.key ? '' : cat.key),
              title: cat.label + ' · ' + n + ' 个文件',
            },
            TYPE_ICON[cat.key] || TYPE_ICON.other,
            cat.label,
            h('span', { className: 'sfv-chip-n' }, String(n)),
          ),
        );
      }
      return h('div', { className: 'sfv-chips' }, children);
    }

    /* ============================================================ 筛选：标签多选 */

    /**
     * 标签多选选择器（纯展示组件：query / open 由外层持有，
     * 这样整个面板视图层零 hooks，离线渲染测试可以直接喂 props）。
     */
    function TagPicker(props) {
      const query = props.query || '';
      const open = Boolean(props.open);
      const all = props.all || [];
      const selected = props.selected || [];
      const selectedSet = new Set(selected);
      const q = query.trim().toLowerCase();
      const matched = (q ? all.filter((t) => includesLoose(t.tag, q)) : all).slice(0, 80);

      const drop = open
        ? h(
            'div',
            { className: 'sfv-tagdrop' },
            matched.length === 0
              ? h('div', { className: 'sfv-tagempty' }, q ? '没有匹配的标签' : '索引里还没有标签')
              : matched.map((t) =>
                  h(
                    'div',
                    {
                      key: t.tag,
                      className: 'sfv-tagitem' + (selectedSet.has(t.tag) ? ' sfv-on' : ''),
                      // onMouseDown 而不是 onClick：避免 input blur 先关掉浮层
                      onMouseDown: (e) => {
                        e.preventDefault();
                        props.onToggle(t.tag);
                      },
                    },
                    selectedSet.has(t.tag) ? '✓' : '·',
                    h('span', null, t.tag),
                    h('span', { className: 'sfv-tagitem-n' }, String(t.count)),
                  ),
                ),
          )
        : null;

      return h(
        'div',
        { className: 'sfv-tagbar' },
        h(
          'div',
          { className: 'sfv-tagpick' },
          h('input', {
            className: 'sfv-search',
            type: 'text',
            value: query,
            placeholder: '添加内容标签…',
            onFocus: () => props.onOpen(true),
            onBlur: () => props.onBlur(),
            onChange: (e) => props.onQuery(e.target.value),
            onKeyDown: (e) => {
              if (e.key === 'Escape') {
                props.onQuery('');
                props.onOpen(false);
              } else if (e.key === 'Enter' && matched.length > 0) {
                props.onToggle(matched[0].tag);
                props.onQuery('');
              }
            },
          }),
          drop,
        ),
        h(
          'div',
          { className: 'sfv-sel' },
          selected.length === 0
            ? h('span', { className: 'sfv-hint' }, '不按标签筛选（支持多选，默认「须同时包含」）')
            : selected.map((tag) =>
                h(
                  'span',
                  {
                    key: tag,
                    className: 'sfv-selchip',
                    title: '点击移除',
                    onClick: () => props.onToggle(tag),
                  },
                  tag,
                  h('span', { className: 'sfv-selchip-x' }, '✕'),
                ),
              ),
        ),
      );
    }

    /* ============================================================ 列表行 */

    function FileRow(props) {
      const rec = props.rec;
      const open = props.open;
      const manualMode = Boolean(props.manualMode);
      const favorite = Boolean(props.favorite);
      const typeLabel = rec.tags.typeLabel || (props.typeLabels && props.typeLabels[rec.tags.type]) || rec.tags.type || '其他';
      const contentTags = rec.tags.content || [];
      const manualContent = (rec.userTags && rec.userTags.content) || [];
      const manualSet = new Set(manualContent);
      const shown = contentTags.slice(0, 4);
      const rest = contentTags.length - shown.length;
      const stamp = stampOf(rec.lastPresentedAt);

      const tags = shown.map((tag) =>
        h(
          'span',
          {
            key: 'tag:' + tag,
            className: 'sfv-tag' + (manualSet.has(tag) ? ' sfv-manual' : ''),
            style: tagStyle(tag),
            title: manualSet.has(tag) ? tag + '（手动）' : tag,
          },
          tag,
        ),
      );
      if (rest > 0) tags.push(h('span', { key: 'tag:rest', className: 'sfv-badge-n' }, '+' + rest));

      // 手动同步模式才有爱心：空心 = 未收藏，红底 = 已收藏（会被复制到本地同步目录）
      const heart = manualMode
        ? h(
            'button',
            {
              type: 'button',
              key: 'heart',
              className: 'sfv-heart' + (favorite ? ' sfv-on' : ''),
              title: favorite ? '已收藏（会同步到本地目录），点击取消' : '收藏这个文件（会同步到本地目录）',
              'aria-pressed': favorite ? 'true' : 'false',
              onClick: (e) => {
                if (e && e.stopPropagation) e.stopPropagation();
                if (props.onFavorite) props.onFavorite(rec.id, !favorite);
              },
            },
            favorite ? '♥' : '♡',
          )
        : null;

      const line1 = h(
        'div',
        { className: 'sfv-row-l1' },
        h('span', { className: 'sfv-name' + (rec.exists ? '' : ' sfv-gone'), title: rec.path }, rec.name),
        h('span', { className: 'sfv-row-meta' }, fmtSize(rec.sizeBytes)),
        heart,
      );

      const line2 = h(
        'div',
        { className: 'sfv-row-l2' },
        h(
          'span',
          { className: 'sfv-tag', style: typeStyle(rec.tags.type) },
          TYPE_ICON[rec.tags.type] || TYPE_ICON.other,
          ' ',
          typeLabel,
        ),
        tags,
        !rec.exists ? h('span', { className: 'sfv-badge-miss' }, '文件已不在磁盘') : null,
        rec.presentCount > 1 ? h('span', { className: 'sfv-badge-n' }, '交付 ' + rec.presentCount + ' 次') : null,
      );

      return h(
        'li',
        { className: 'sfv-tl' },
        h('span', { className: 'sfv-tl-dot' }),
        h(
          'div',
          { className: 'sfv-tl-when', title: '最近交付 ' + stamp.full },
          h('b', null, stamp.md),
          h('span', null, stamp.hm),
        ),
        h(
          'div',
          { className: 'sfv-tl-card' },
          h(
            'div',
            {
              className: 'sfv-row' + (open ? ' sfv-open' : ''),
              onClick: () => props.onToggle(rec.id),
              title: open ? '收起详情' : '展开详情',
            },
            h('span', { className: 'sfv-row-ico' }, TYPE_ICON[rec.tags.type] || TYPE_ICON.other),
            h('div', { className: 'sfv-row-main' }, line1, line2),
          ),
          open ? h(FileDetail, { id: rec.id, rec: rec, detail: props.detail, onRetry: props.onDetailRetry }) : null,
        ),
      );
    }

    /* ============================================================ 展开详情 */

    function FileDetail(props) {
      const rec = props.rec;
      const detail = props.detail;
      const loading = !detail || detail.loading;
      const error = detail && detail.error;

      if (error) {
        return h(
          'div',
          { className: 'sfv-detail' },
          h('div', { className: 'sfv-err' }, '详情加载失败：' + error),
          h(
            'button',
            { type: 'button', className: 'sfv-btn', onClick: (e) => { e.stopPropagation(); props.onRetry(rec.id); } },
            '重试',
          ),
        );
      }
      if (loading) return h('div', { className: 'sfv-detail' }, h('span', { className: 'sfv-hint' }, '加载中…'));

      const data = detail.data || {};
      const sessions = (data.sessions || []).slice().sort((a, b) => (b.time || 0) - (a.time || 0));
      const descs = data.descriptions || [];

      const rows = [
        h(
          'div',
          { className: 'sfv-kv', key: 'path' },
          h('span', { className: 'sfv-kv-k' }, '路径'),
          h('span', { className: 'sfv-kv-v sfv-mono' }, data.path || rec.path),
        ),
        h(
          'div',
          { className: 'sfv-kv', key: 'size' },
          h('span', { className: 'sfv-kv-k' }, '体积'),
          h(
            'span',
            { className: 'sfv-kv-v' },
            fmtSize(data.sizeBytes) + ' · ' + (data.exists ? '在磁盘' : '已缺失') +
              (data.presentCount > 1 ? ' · 首次交付 ' + ymdOf(data.firstPresentedAt) : ''),
          ),
        ),
      ];

      if (descs.length > 0) {
        rows.push(
          h(
            'div',
            { className: 'sfv-sect', key: 'descs' },
            h('div', { className: 'sfv-sect-t' }, '交付时模型的描述（' + descs.length + '）'),
            descs.slice(0, 6).map((d, i) =>
              h('div', { className: 'sfv-desc', key: 'd' + i }, h('span', { className: 'sfv-desc-t' }, '·'), h('span', null, d)),
            ),
          ),
        );
      }

      if (sessions.length > 0) {
        rows.push(
          h(
            'div',
            { className: 'sfv-sect', key: 'sessions' },
            h('div', { className: 'sfv-sect-t' }, '出现过的会话（' + sessions.length + '）'),
            sessions.slice(0, 8).map((s, i) =>
              h(
                'div',
                { className: 'sfv-sess', key: 's' + i },
                h('span', { className: 'sfv-sess-t' }, hmOf(s.time)),
                h('span', { className: 'sfv-sess-n', title: (s.title || s.sessionId) }, s.title || s.sessionId),
                h('span', { className: 'sfv-sess-p', title: s.cwd || s.projectLabel || '' }, s.projectLabel || shortDir(s.cwd) || ''),
              ),
            ),
          ),
        );
      }

      return h('div', { className: 'sfv-detail' }, rows);
    }

    /* ============================================================ 纯筛选逻辑 */

    /**
     * 从 /state 的载荷里算出「筛选后的行 + 全量维度统计」。
     * 纯函数（无 hooks、无副作用），离线渲染测试可以直接调用。
     */
    function selectRecords(data, filter) {
      const f = filter || {};
      const text = String(f.text || '').trim().toLowerCase();
      const type = f.type || '';
      const tags = f.tags || [];
      const from = f.from || '';
      const to = f.to || '';
      const sort = f.sort || 'recent';

      const all = (data && data.records) || [];
      const typeLabels = {};
      const cats = (data && data.meta && data.meta.typeCategories) || [];
      for (const c of cats) typeLabels[c.key] = c.label;

      const typeCounts = {};
      const tagCount = new Map();
      for (const rec of all) {
        const t = (rec.tags && rec.tags.type) || 'other';
        typeCounts[t] = (typeCounts[t] || 0) + 1;
        for (const tag of (rec.tags && rec.tags.content) || []) {
          tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
        }
      }
      const allTags = Array.from(tagCount.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));

      const rows = [];
      for (const rec of all) {
        const t = rec.tags || {};
        if (type && t.type !== type) continue;
        if (tags.length > 0) {
          const own = new Set(t.content || []);
          let ok = true;
          for (const tag of tags) {
            if (!own.has(tag)) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
        }
        if (from || to) {
          const date = t.date || ymdOf(rec.lastPresentedAt);
          if (!date) continue;
          if (from && date < from) continue;
          if (to && date > to) continue;
        }
        if (text) {
          const hay = [
            rec.name,
            rec.path,
            rec.dir,
            rec.localTitle,
            (rec.descriptions || []).join(' '),
            (t.content || []).join(' '),
            (rec.userTags && rec.userTags.content ? rec.userTags.content.join(' ') : ''),
          ]
            .filter(Boolean)
            .join('\n')
            .toLowerCase();
          if (hay.indexOf(text) < 0) continue;
        }
        rows.push(rec);
      }

      if (sort === 'name') rows.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      else if (sort === 'size') rows.sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
      else if (sort === 'count') rows.sort((a, b) => (b.presentCount || 0) - (a.presentCount || 0) || (b.lastPresentedAt || 0) - (a.lastPresentedAt || 0));
      else rows.sort((a, b) => (b.lastPresentedAt || 0) - (a.lastPresentedAt || 0));

      return { rows, allTags, typeCounts, typeLabels, totalAll: all.length };
    }

    /* ============================================================ 脑图布局 */

    // 画布固定 1240×1240 的 viewBox，实际显示宽度交给 CSS（矢量缩放不糊）。
    const GRAPH_SIZE = 1240;
    const GRAPH_CX = GRAPH_SIZE / 2;
    const GRAPH_R_DIM = 250; // 维度节点（标签 / 类型）所在圆的半径
    const GRAPH_DIM_LANE = 62; // 维度内轨与主轨的半径差（长尾标签过密时交替使用）
    const GRAPH_R_FILE = 560; // 文件节点所在圆的半径
    const GRAPH_TAG_NONE = '__untagged__'; // 「未打标签 / 未分类」的伪维度键
    const GRAPH_LABEL_MIN = 8; // 标签模式下，文件数 >= 8 的维度才显示文字标签
    const GRAPH_ZOOM_MIN = 0.45; // 最小缩放（再小就看不清圆点）
    const GRAPH_ZOOM_MAX = 5; // 最大缩放
    const GRAPH_ZOOM_WHEEL = 0.0016; // 滚轮 deltaY → 缩放指数的系数（一格约 12%）
    const GRAPH_PAN_KEEP = 0.2; // 平移时至少保留画布 20% 的内容可见，防止把图拖丢

    function clampNum(v, lo, hi) {
      if (!isFinite(v)) return lo;
      return v < lo ? lo : v > hi ? hi : v;
    }

    /* ---------------- 脑图视口（平移 / 缩放）----------------
     * 变换固定为 translate(x, y) scale(k)：屏幕坐标 s = x + k * 用户坐标。
     * 下面几个函数全是纯函数，便于离线断言（不在里面碰 DOM）。 */

    function clampGraphZoom(k) {
      const v = typeof k === 'number' && isFinite(k) ? k : 1;
      return clampNum(v, GRAPH_ZOOM_MIN, GRAPH_ZOOM_MAX);
    }

    /** 约束视口：缩放后至少留 GRAPH_PAN_KEEP 的内容在画布内。 */
    function clampGraphView(view) {
      const k = clampGraphZoom(view && view.k);
      const lo = GRAPH_PAN_KEEP * GRAPH_SIZE - k * GRAPH_SIZE;
      const hi = (1 - GRAPH_PAN_KEEP) * GRAPH_SIZE;
      const x = clampNum(view && typeof view.x === 'number' ? view.x : 0, lo, hi);
      const y = clampNum(view && typeof view.y === 'number' ? view.y : 0, lo, hi);
      return { k: k, x: x, y: y };
    }

    /** 以视图坐标 (sx, sy) 为焦点缩放 factor 倍：该点在画面上保持不动。 */
    function zoomGraphView(view, factor, sx, sy) {
      const base = clampGraphView(view);
      const f = typeof factor === 'number' && isFinite(factor) && factor > 0 ? factor : 1;
      const k = clampGraphZoom(base.k * f);
      const ratio = k / base.k;
      const px = typeof sx === 'number' && isFinite(sx) ? sx : GRAPH_CX;
      const py = typeof sy === 'number' && isFinite(sy) ? sy : GRAPH_CX;
      return clampGraphView({ k: k, x: px - ratio * (px - base.x), y: py - ratio * (py - base.y) });
    }

    /** 平移：dx / dy 已是 viewBox 单位（调用方按屏幕像素折算好）。 */
    function panGraphView(view, dx, dy) {
      const base = clampGraphView(view);
      const mx = typeof dx === 'number' && isFinite(dx) ? dx : 0;
      const my = typeof dy === 'number' && isFinite(dy) ? dy : 0;
      return clampGraphView({ k: base.k, x: base.x + mx, y: base.y + my });
    }

    /** 容器像素 / viewBox 单位的比例（preserveAspectRatio=meet，取短边）。 */
    function graphScaleOf(rect) {
      const rw = rect && isFinite(rect.width) ? rect.width : GRAPH_SIZE;
      const rh = rect && isFinite(rect.height) ? rect.height : GRAPH_SIZE;
      if (!(rw > 0) || !(rh > 0)) return 1;
      const sc = Math.min(rw / GRAPH_SIZE, rh / GRAPH_SIZE);
      return sc > 0 ? sc : 1;
    }

    /** 屏幕坐标 → SVG 用户坐标（viewBox 内，未叠加 translate/scale）。 */
    function screenToGraphPoint(rect, clientX, clientY) {
      const rw = rect && isFinite(rect.width) ? rect.width : GRAPH_SIZE;
      const rh = rect && isFinite(rect.height) ? rect.height : GRAPH_SIZE;
      const left = rect && isFinite(rect.left) ? rect.left : 0;
      const top = rect && isFinite(rect.top) ? rect.top : 0;
      const sc = graphScaleOf(rect);
      const ox = (rw - GRAPH_SIZE * sc) / 2;
      const oy = (rh - GRAPH_SIZE * sc) / 2;
      const cx = typeof clientX === 'number' && isFinite(clientX) ? clientX : 0;
      const cy = typeof clientY === 'number' && isFinite(clientY) ? clientY : 0;
      return { sx: (cx - left - ox) / sc, sy: (cy - top - oy) / sc };
    }

    function graphTransformOf(view) {
      const v = clampGraphView(view);
      return 'translate(' + v.x.toFixed(2) + ',' + v.y.toFixed(2) + ') scale(' + v.k.toFixed(4) + ')';
    }

    /**
     * 取一条记录在某个维度下的键。
     * 没有任何标签时返回伪维度键，保证「未打标签」的文件也能出现在图上。
     */
    function graphDimKeys(rec, isType) {
      const tags = (rec && rec.tags) || null;
      const raw = isType ? [tags && tags.type] : tags && Array.isArray(tags.content) ? tags.content : [];
      const out = [];
      for (let i = 0; i < raw.length; i += 1) {
        const key = typeof raw[i] === 'string' ? raw[i].trim() : '';
        if (key && out.indexOf(key) < 0) out.push(key);
      }
      return out.length > 0 ? out : [GRAPH_TAG_NONE];
    }

    function graphDimLabel(key, isType, typeLabels) {
      if (key === GRAPH_TAG_NONE) return isType ? '未分类' : '未打标签';
      if (isType) return (typeLabels && typeLabels[key]) || key;
      return key;
    }

    /**
     * 由当前筛选后的记录算出脑图的全部几何。
     *
     * 布局是确定性的（同样的输入永远得到同样的坐标，便于离线断言）：
     *   1. 维度按文件数从多到少排序，按 count 比例切分整圈角度；
     *   2. 每个文件归给「最先认领它的维度」，因此每个文件只画一个节点；
     *   3. 文件在自己维度那块扇形里展开，相邻两个交错半径，避免小角度下互相压盖；
     *   4. 连线连到该文件所属的全部维度，多标签关系一眼可见。
     */
    function buildGraph(rows, dim, typeLabels) {
      const isType = dim === 'type';
      const list = Array.isArray(rows) ? rows : [];
      const total = list.length;
      const empty = { w: GRAPH_SIZE, h: GRAPH_SIZE, cx: GRAPH_CX, cy: GRAPH_CX, dims: [], files: [], edges: [], total: 0 };
      if (total === 0) return empty;

      // 1) 收集维度
      const order = [];
      const byKey = Object.create(null);
      for (let i = 0; i < list.length; i += 1) {
        const rec = list[i];
        const keys = graphDimKeys(rec, isType);
        for (let k = 0; k < keys.length; k += 1) {
          let group = byKey[keys[k]];
          if (!group) {
            group = { key: keys[k], count: 0, files: [] };
            byKey[keys[k]] = group;
            order.push(group);
          }
          group.count += 1;
          group.files.push(rec);
        }
      }
      const groups = order.slice().sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
      const sumCount = groups.reduce((s, g) => s + g.count, 0) || 1;

      // 2) 每个文件只归一个主维度（先到先得，靠 dims 的排序保证归给最大的维度）
      const claimed = Object.create(null);
      for (let i = 0; i < groups.length; i += 1) {
        const group = groups[i];
        const own = [];
        for (let k = 0; k < group.files.length; k += 1) {
          const rec = group.files[k];
          if (claimed[rec.id]) continue;
          claimed[rec.id] = true;
          own.push(rec);
        }
        own.sort((a, b) => (b.lastPresentedAt || 0) - (a.lastPresentedAt || 0));
        group.own = own;
      }

      // 3) 维度节点：按 count 比例落在自己那块扇形的中心。
      //    长尾标签会挤成很窄的扇形，圆挨圆必然叠在一起，所以相邻角距过近时交替放到内外两条轨道上。
      const startAngle = -Math.PI / 2;
      let acc = 0;
      const dimNodes = [];
      let laneFlip = 0;
      let lanePrevAngle = null;
      for (let i = 0; i < groups.length; i += 1) {
        const group = groups[i];
        const share = group.count / sumCount;
        const mid = startAngle + Math.PI * 2 * (acc + share / 2);
        acc += share;
        const nodeR = clampNum(10 + 2.4 * Math.sqrt(group.count), 10, 26);
        let nodeRadius = GRAPH_R_DIM;
        if (lanePrevAngle !== null) {
          const gap = Math.abs(mid - lanePrevAngle);
          const arc = Math.min(gap, Math.PI * 2 - gap) * GRAPH_R_DIM;
          if (arc < nodeR * 2 + 26) {
            laneFlip = 1 - laneFlip;
            nodeRadius = laneFlip === 1 ? GRAPH_R_DIM - GRAPH_DIM_LANE : GRAPH_R_DIM;
          }
        }
        lanePrevAngle = mid;
        const node = {
          key: group.key,
          label: graphDimLabel(group.key, isType, typeLabels),
          count: group.count,
          own: group.own.length,
          share: share,
          angle: mid,
          r: nodeR,
          radius: nodeRadius,
          x: GRAPH_CX + Math.cos(mid) * nodeRadius,
          y: GRAPH_CX + Math.sin(mid) * nodeRadius,
          showLabel: isType ? true : group.count >= GRAPH_LABEL_MIN,
        };
        const dx = node.x - GRAPH_CX;
        const dy = node.y - GRAPH_CX;
        if (Math.abs(dx) > 70) {
          node.anchor = dx > 0 ? 'start' : 'end';
          node.labelX = dx > 0 ? node.r + 8 : -(node.r + 8);
          node.labelY = 4;
        } else {
          node.anchor = 'middle';
          node.labelX = 0;
          node.labelY = dy < 0 ? -(node.r + 10) : node.r + 16;
        }
        dimNodes.push(node);
        byKey[group.key].node = node;
      }

      // 4) 文件节点：在自己维度那块扇形里展开，奇偶交错半径
      const files = [];
      const fileById = Object.create(null);
      for (let i = 0; i < dimNodes.length; i += 1) {
        const dimNode = dimNodes[i];
        const own = groups[i].own;
        const n = own.length;
        const span = Math.PI * 2 * dimNode.share;
        const step = n > 1 ? Math.min(span / n, 0.14) : 0;
        for (let k = 0; k < n; k += 1) {
          const rec = own[k];
          const angle = n > 1 ? dimNode.angle + (k - (n - 1) / 2) * step : dimNode.angle;
          const radius = GRAPH_R_FILE + (k % 2 === 0 ? 0 : 36);
          const count = Math.max(1, rec.presentCount || 1);
          const node = {
            id: rec.id,
            name: rec.name || '',
            count: count,
            exists: rec.exists !== false,
            angle: angle,
            r: clampNum(2.2 + 1.1 * Math.sqrt(count), 2.2, 9),
            x: GRAPH_CX + Math.cos(angle) * radius,
            y: GRAPH_CX + Math.sin(angle) * radius,
          };
          files.push(node);
          fileById[node.id] = node;
        }
      }

      // 5) 连线：文件连到它所属的全部维度（含主维度之外的，体现多标签关系）
      const edges = [];
      for (let i = 0; i < list.length; i += 1) {
        const rec = list[i];
        const file = fileById[rec.id];
        if (!file) continue;
        const keys = graphDimKeys(rec, isType);
        for (let k = 0; k < keys.length; k += 1) {
          const dimNode = byKey[keys[k]] && byKey[keys[k]].node;
          if (!dimNode) continue;
          edges.push({
            key: rec.id + '>' + keys[k],
            from: keys[k],
            to: rec.id,
            x1: dimNode.x,
            y1: dimNode.y,
            x2: file.x,
            y2: file.y,
          });
        }
      }

      return {
        w: GRAPH_SIZE,
        h: GRAPH_SIZE,
        cx: GRAPH_CX,
        cy: GRAPH_CX,
        dims: dimNodes,
        files: files,
        edges: edges,
        total: total,
        dimCount: dimNodes.length,
        edgeCount: edges.length,
      };
    }

    /** 脑图（纯渲染，无内部状态；交互全部回调给外层）。 */
    function GraphView(props) {
      const graph = props.graph;
      if (!graph || !graph.files || graph.files.length === 0) {
        return h('div', { className: 'sfv-graph-empty' }, '当前筛选下没有文件，脑图暂无可绘制的内容。');
      }
      const selectedDims = props.selectedDims || {};
      const selectedId = props.selectedId || '';
      const nodes = [];

      // 边先画，压在节点下面
      for (let i = 0; i < graph.edges.length; i += 1) {
        const e = graph.edges[i];
        nodes.push(
          h('line', { key: 'e:' + e.key, className: 'sfv-gedge', x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }),
        );
      }

      // 维度节点（内圈）
      for (let i = 0; i < graph.dims.length; i += 1) {
        const d = graph.dims[i];
        const cls = 'sfv-gdim' + (selectedDims[d.key] ? ' sfv-sel' : '');
        nodes.push(
          h(
            'g',
            {
              key: 'd:' + d.key,
              className: cls,
              transform: 'translate(' + d.x.toFixed(2) + ',' + d.y.toFixed(2) + ')',
              onClick: () => {
                if (d.key === GRAPH_TAG_NONE) return;
                if (props.onPickDim) props.onPickDim(d.key);
              },
            },
            h('circle', { r: d.r.toFixed(2) }),
            h('title', null, d.label + ' · ' + d.count + ' 个文件（点击按此筛选）'),
            d.showLabel ? h('text', { x: d.labelX, y: d.labelY, textAnchor: d.anchor }, d.label) : null,
            h('text', { className: 'sfv-gdim-c', x: 0, y: 4, textAnchor: 'middle' }, String(d.count)),
          ),
        );
      }

      // 文件节点（外圈）
      for (let i = 0; i < graph.files.length; i += 1) {
        const f = graph.files[i];
        let cls = 'sfv-gfile';
        if (!f.exists) cls += ' sfv-miss';
        if (selectedId && selectedId === f.id) cls += ' sfv-sel';
        nodes.push(
          h(
            'g',
            {
              key: 'f:' + f.id,
              className: cls,
              transform: 'translate(' + f.x.toFixed(2) + ',' + f.y.toFixed(2) + ')',
              onClick: () => {
                if (props.onPickFile) props.onPickFile(f.id);
              },
            },
            h('circle', { r: f.r.toFixed(2) }),
            h('title', null, f.name + (f.exists ? '' : '（已失效）') + ' · 交付 ' + f.count + ' 次 · 点击查看详情'),
          ),
        );
      }

      return h(
        'svg',
        {
          className: 'sfv-graph',
          viewBox: '0 0 ' + graph.w + ' ' + (graph.h || graph.w),
          preserveAspectRatio: 'xMidYMid meet',
          xmlns: 'http://www.w3.org/2000/svg',
          role: 'img',
          'aria-label': '文件关系脑图',
        },
        h('g', { className: 'sfv-glayer', transform: graphTransformOf(props.view) }, nodes),
      );
    }

    /* ============================================================ 面板视图 */

    function PanelView(props) {
      const view = props.view || {};
      const data = view.data || null;
      const filter = props.filter || {};
      const busy = props.busy || '';
      const nowMs = typeof props.nowMs === 'number' ? props.nowMs : Date.now();
      const sel = selectRecords(data, filter);
      const meta = (data && data.meta) || null;
      const rebuilding = Boolean(data && data.rebuilding);
      const progress = (data && data.progress) || null;
      const cols = COLS_ALLOWED.indexOf(props.cols) >= 0 ? props.cols : 1;
      const syncSettings = props.settings || (data && data.settings) || {};
      const manualMode = syncSettings.syncMode === 'manual';
      const favSet = new Set((data && data.favorites) || []);

      /* ---- 顶栏 ---- */
      const head = h(
        'header',
        { className: 'sfv-head' },
        h(
          'div',
          { className: 'sfv-head-row' },
          h('span', { className: 'sfv-title' }, LABEL),
          meta
            ? h(
                'span',
                { className: 'sfv-sub' },
                meta.total + ' 个文件 · ' + meta.existsCount + ' 在盘' + (meta.missingCount ? ' · ' + meta.missingCount + ' 缺失' : '') +
                  ' · 索引 ' + (meta.generatedAt ? ymdOf(meta.generatedAt) + ' ' + hmOf(meta.generatedAt).slice(6) : '未知'),
              )
            : null,
          h('span', { className: 'sfv-spacer' }),
          h(
            'div',
            { className: 'sfv-viewswitch', role: 'group', title: '切换列表 / 脑图' },
            h(
              'button',
              {
                type: 'button',
                className: props.mode === 'graph' ? '' : 'sfv-on',
                onClick: () => {
                  if (props.onMode) props.onMode('list');
                },
              },
              '列表',
            ),
            h(
              'button',
              {
                type: 'button',
                className: props.mode === 'graph' ? 'sfv-on' : '',
                onClick: () => {
                  if (props.onMode) props.onMode('graph');
                },
              },
              '脑图',
            ),
          ),
          h(
            'div',
            { className: 'sfv-viewswitch', role: 'group', title: '每行显示几列' },
            COLS_ALLOWED.map((n) =>
              h(
                'button',
                {
                  key: 'cols' + n,
                  type: 'button',
                  className: cols === n ? 'sfv-on' : '',
                  onClick: () => {
                    if (props.onCols) props.onCols(n);
                  },
                },
                n + ' 列',
              ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'sfv-btn',
              onClick: () => {
                if (props.onOpenSettings) props.onOpenSettings();
              },
              title: '同步目录与同步范围设置',
            },
            '⚙ 设置',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'sfv-btn',
              disabled: Boolean(busy) || rebuilding,
              onClick: props.onReload,
              title: '重新读取磁盘上的索引文件（不重新扫描会话）',
            },
            busy === 'reload' ? '读取中…' : '刷新',
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'sfv-btn sfv-primary',
              disabled: Boolean(busy) || rebuilding,
              onClick: props.onRebuild,
              title: '重新扫描全部会话日志并重建索引（约十几秒）',
            },
            restoringLabel(busy, rebuilding),
          ),
        ),
        h(
          'div',
          { className: 'sfv-search-row' },
          h('input', {
            className: 'sfv-search',
            type: 'search',
            value: filter.text || '',
            placeholder: '搜索文件名 / 路径 / 模型描述 / 标签…',
            onChange: (e) => props.onText(e.target.value),
          }),
          h('input', {
            className: 'sfv-date',
            type: 'date',
            value: filter.from || '',
            title: '交付日期起',
            onChange: (e) => props.onFrom(e.target.value),
          }),
          h('span', { className: 'sfv-date-sep' }, '→'),
          h('input', {
            className: 'sfv-date',
            type: 'date',
            value: filter.to || '',
            title: '交付日期止',
            onChange: (e) => props.onTo(e.target.value),
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'sfv-btn' + (hasFilter(filter) ? '' : ' sfv-on'),
              onClick: props.onClear,
              title: '清空全部筛选条件',
            },
            hasFilter(filter) ? '清空筛选' : '无筛选',
          ),
          h(
            'select',
            {
              className: 'sfv-date',
              value: filter.sort || 'recent',
              title: '排序方式',
              onChange: (e) => props.onSort(e.target.value),
            },
            SORT_MODES.map(([k, label]) => h('option', { key: k, value: k }, label)),
          ),
        ),
        data && data.ready
          ? h(TypeChips, {
              categories: (meta && meta.typeCategories) || [],
              counts: sel.typeCounts,
              value: filter.type || '',
              total: sel.totalAll,
              onChange: props.onType,
            })
          : null,
        data && data.ready
          ? h(TagPicker, {
              all: sel.allTags,
              selected: filter.tags || [],
              query: props.tagQuery || '',
              open: Boolean(props.tagOpen),
              onQuery: props.onTagQuery,
              onOpen: props.onTagOpen,
              onBlur: props.onTagBlur,
              onToggle: props.onToggleTag,
            })
          : null,
      );

      /* ---- 主体 ---- */
      let body = null;
      if (view.loading) {
        body = h(
          'div',
          { className: 'sfv-center' },
          h('div', { className: 'sfv-center-t' }, '正在加载文件索引…'),
          h('div', { className: 'sfv-center-s' }, '首次打开需要读取索引文件；若尚未建立索引，会自动扫描会话日志。'),
        );
      } else if (view.error) {
        body = h(
          'div',
          { className: 'sfv-center' },
          h('div', { className: 'sfv-center-t sfv-err' }, '加载失败'),
          h('div', { className: 'sfv-center-s' }, view.error),
          h('button', { type: 'button', className: 'sfv-btn', onClick: props.onReload }, '重试'),
        );
      } else if (!data || !data.ready) {
        const pct = progress && progress.total ? Math.min(100, Math.round((progress.scanned / progress.total) * 100)) : 0;
        body = h(
          'div',
          { className: 'sfv-center' },
          h('div', { className: 'sfv-center-t' }, rebuilding ? '正在建立文件索引…' : '还没有索引'),
          h(
            'div',
            { className: 'sfv-center-s' },
            rebuilding
              ? progress && progress.total
                ? '已扫描 ' + progress.scanned + ' / ' + progress.total + ' 个会话日志，共 ' + progress.phase
                : '正在扫描会话日志（数百个文件，约十几秒）…'
              : '点击右上角「重建索引」扫描本机全部 DSH 会话，把模型主动交付的文件归集起来。',
          ),
          rebuilding ? h('div', { className: 'sfv-progress' }, h('div', { className: 'sfv-progress-i', style: { width: pct + '%' } })) : null,
          rebuilding ? null : h('button', { type: 'button', className: 'sfv-btn sfv-primary', onClick: props.onRebuild }, '重建索引'),
        );
      } else if (props.mode === 'graph') {
        const dim = props.graphDim === 'type' ? 'type' : 'tag';
        const graph = buildGraph(sel.rows, dim, sel.typeLabels);
        const gview = props.graphView || null;
        const zoomPct = Math.round(clampGraphZoom(gview && gview.k) * 100) + '%';
        const selectedDims = {};
        if (dim === 'type') {
          if (filter.type) selectedDims[filter.type] = true;
        } else if (Array.isArray(filter.tags)) {
          for (let i = 0; i < filter.tags.length; i += 1) selectedDims[filter.tags[i]] = true;
        }
        const pickDim = (key) => {
          if (dim === 'type') {
            if (props.onType) props.onType(filter.type === key ? '' : key);
          } else if (props.onToggleTag) {
            props.onToggleTag(key);
          }
        };
        body = h(
          'div',
          { className: 'sfv-graph-page' },
          h(
            'div',
            { className: 'sfv-graphbar' },
            h('span', { className: 'sfv-graphbar-t' }, '按'),
            h(
              'div',
              { className: 'sfv-viewswitch' },
              h(
                'button',
                {
                  type: 'button',
                  className: dim === 'tag' ? 'sfv-on' : '',
                  onClick: () => {
                    if (props.onGraphDim) props.onGraphDim('tag');
                  },
                },
                '内容标签',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: dim === 'type' ? 'sfv-on' : '',
                  onClick: () => {
                    if (props.onGraphDim) props.onGraphDim('type');
                  },
                },
                '文件类型',
              ),
            ),
            h('span', { className: 'sfv-graphbar-t' }, '聚合 · ' + graph.dimCount + ' 组 / ' + graph.total + ' 个文件'),
            h('span', { className: 'sfv-spacer' }),
            h(
              'div',
              { className: 'sfv-gzoom' },
              h(
                'button',
                {
                  type: 'button',
                  title: '缩小',
                  onClick: () => {
                    if (props.onGraphZoom) props.onGraphZoom(1 / 1.25);
                  },
                },
                '－',
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'sfv-gzoom-k',
                  title: '当前缩放比例，点击复位到 100%',
                  onClick: () => {
                    if (props.onGraphReset) props.onGraphReset();
                  },
                },
                zoomPct,
              ),
              h(
                'button',
                {
                  type: 'button',
                  title: '放大',
                  onClick: () => {
                    if (props.onGraphZoom) props.onGraphZoom(1.25);
                  },
                },
                '＋',
              ),
            ),
            h('span', { className: 'sfv-graphbar-hint' }, '拖拽平移 · 滚轮缩放 · 点小圆看详情 · 点大圆按该组筛选'),
          ),
          h(
            'div',
            {
              className: 'sfv-graph-wrap',
              ref: props.graphRef,
              onMouseDown: props.onGraphPanStart,
              onClickCapture: props.onGraphClickCapture,
              title: '按住拖动平移 · 滚轮缩放',
            },
            h(GraphView, {
              graph: graph,
              view: gview,
              selectedDims: selectedDims,
              selectedId: props.openId,
              onPickDim: pickDim,
              onPickFile: props.onPickFile,
            }),
          ),
        );
      } else if (sel.rows.length === 0) {
        body = h(
          'div',
          { className: 'sfv-center' },
          h('div', { className: 'sfv-center-t' }, sel.totalAll === 0 ? '索引里还没有文件' : '没有匹配的文件'),
          h(
            'div',
            { className: 'sfv-center-s' },
            sel.totalAll === 0
              ? '索引已建立但一条记录都没有：可能还没有会话主动交付过文件，或会话日志已清理。'
              : '当前筛选条件下没有结果，可以放宽条件再试。',
          ),
          hasFilter(filter) ? h('button', { type: 'button', className: 'sfv-btn', onClick: props.onClear }, '清空筛选') : null,
        );
      } else {
        body = h(
          'ul',
          { className: 'sfv-list sfv-cols-' + cols },
          sel.rows.map((rec) =>
            h(FileRow, {
              key: rec.id,
              rec: rec,
              nowMs: nowMs,
              typeLabels: sel.typeLabels,
              open: props.openId === rec.id,
              detail: (props.details || {})[rec.id],
              manualMode: manualMode,
              favorite: favSet.has(rec.id),
              onToggle: props.onToggleRow,
              onFavorite: props.onFavorite,
              onDetailRetry: props.onLoadDetail,
            }),
          ),
        );
      }

      const notice = props.notice
        ? h('div', { className: 'sfv-notice' }, props.notice)
        : null;

      return h(
        'div',
        { className: 'sfv-root' },
        head,
        notice,
        h('div', { className: 'sfv-body' }, body),
        props.settingsOpen
          ? h(SettingsModal, {
              settings: syncSettings,
              categories: (meta && meta.typeCategories) || [],
              lastSyncAt: (data && data.lastSyncAt) || null,
              onClose: props.onCloseSettings,
              onSaved: props.onSettingsSaved,
              onSynced: props.onSynced,
            })
          : null,
      );
    }

    function hasFilter(filter) {
      const f = filter || {};
      return Boolean(f.text || f.type || f.from || f.to || (f.tags && f.tags.length > 0));
    }

    function restoringLabel(busy, rebuilding) {
      if (rebuilding) return '重建中…';
      if (busy === 'rebuild') return '启动中…';
      return '重建索引';
    }

    /* ============================================================ 设置弹窗 */

    /**
     * 同步设置。
     * 编辑态都留在本组件内部，保存时把三个字段一起发出去（服务端是 PATCH 语义，
     * 只处理出现过的键，所以这里全量发也不会误清别的字段）。
     */
    function SettingsModal(props) {
      const settings = props.settings || {};
      const [dir, setDir] = React.useState(settings.syncDir || '');
      const [mode, setMode] = React.useState(settings.syncMode || 'all');
      const [types, setTypes] = React.useState(Array.isArray(settings.syncTypes) ? settings.syncTypes : []);
      const [busy, setBusy] = React.useState('');
      const [msg, setMsg] = React.useState('');
      const [report, setReport] = React.useState(null);

      const toggleType = (key) => {
        setTypes((prev) => (prev.indexOf(key) >= 0 ? prev.filter((t) => t !== key) : prev.concat(key)));
      };

      const save = () => {
        if (busy) return;
        if (mode === 'type' && types.length === 0) {
          setMsg('同步范围选了「按类型」，请至少勾选一个文件类型。');
          return;
        }
        setBusy('save');
        setMsg('');
        apiPost('/settings', { syncDir: dir, syncMode: mode, syncTypes: types })
          .then((data) => {
            setMsg('设置已保存。');
            if (props.onSaved) props.onSaved(data.settings);
          })
          .catch((err) => setMsg('保存失败：' + ((err && err.message) || err)))
          .then(() => setBusy(''));
      };

      const doSync = () => {
        if (busy) return;
        setBusy('sync');
        setMsg('');
        setReport(null);
        apiPost('/sync', {})
          .then((data) => {
            setReport(data.report || null);
            if (props.onSynced) props.onSynced(data.report);
          })
          .catch((err) => setMsg('同步失败：' + ((err && err.message) || err)))
          .then(() => setBusy(''));
      };

      const categories = props.categories || [];
      const summary = report
        ? '已复制 ' + report.copied + ' 个 · 更新 ' + report.updated + ' 个 · 跳过 ' + report.skipped + ' 个' +
          (report.failed ? ' · 失败 ' + report.failed + ' 个' : '')
        : '';

      return h(
        'div',
        {
          className: 'sfv-mask',
          onClick: (e) => {
            if (e && e.target === e.currentTarget && props.onClose) props.onClose();
          },
        },
        h(
          'div',
          { className: 'sfv-modal', role: 'dialog', 'aria-label': '文件库设置' },
          h('div', { className: 'sfv-modal-t' }, '设置'),
          h('div', { className: 'sfv-modal-s' }, '把文件库里的文件复制一份到本地目录。只复制，不改动源文件。'),

          h(
            'div',
            { className: 'sfv-field' },
            h('div', { className: 'sfv-field-k' }, '同步目录'),
            h(
              'div',
              { className: 'sfv-dir-row' },
              h('input', {
                className: 'sfv-search',
                type: 'text',
                value: dir,
                placeholder: '例如 D:\\dsh-vault-sync',
                onChange: (e) => setDir(e.target.value),
              }),
            ),
            h('div', { className: 'sfv-field-hint' }, '必须是绝对路径。不同文件重名时不会互相覆盖，会自动让开成「名字 (2).ext」。'),
          ),

          h(
            'div',
            { className: 'sfv-field' },
            h('div', { className: 'sfv-field-k' }, '同步范围'),
            h(
              'div',
              { className: 'sfv-radio-row' },
              ['all', 'type', 'manual'].map((k) =>
                h(
                  'button',
                  {
                    key: k,
                    type: 'button',
                    className: 'sfv-chip' + (mode === k ? ' sfv-on' : ''),
                    onClick: () => setMode(k),
                  },
                  SYNC_MODE_TEXT[k],
                ),
              ),
            ),
            h(
              'div',
              { className: 'sfv-field-hint' },
              mode === 'manual'
                ? '在列表里点文件右侧的 ♡ 收藏；变成红底 ♥ 的文件才会被同步。'
                : mode === 'type'
                  ? '只同步下面勾选类型的文件。'
                  : '索引里的全部文件都会同步。',
            ),
          ),

          mode === 'type'
            ? h(
                'div',
                { className: 'sfv-field' },
                h('div', { className: 'sfv-field-k' }, '文件类型（可多选）'),
                h(
                  'div',
                  { className: 'sfv-radio-row' },
                  categories.map((c) =>
                    h(
                      'button',
                      {
                        key: c.key,
                        type: 'button',
                        className: 'sfv-chip' + (types.indexOf(c.key) >= 0 ? ' sfv-on' : ''),
                        onClick: () => toggleType(c.key),
                      },
                      TYPE_ICON[c.key] || TYPE_ICON.other,
                      ' ',
                      c.label,
                    ),
                  ),
                ),
              )
            : null,

          props.lastSyncAt
            ? h('div', { className: 'sfv-field-hint' }, '上次同步：' + stampOf(props.lastSyncAt).full)
            : null,

          report
            ? h(
                'div',
                { className: 'sfv-sync-res' },
                h('div', null, summary),
                h('div', null, '目标：' + report.dir),
                report.errors && report.errors.length
                  ? h(
                      'div',
                      null,
                      report.errors.slice(0, 3).map((x, i) =>
                        h('div', { key: 'err' + i }, '· ' + (x.name || x.id) + '：' + x.message),
                      ),
                    )
                  : null,
              )
            : null,

          msg ? h('div', { className: 'sfv-modal-s' }, msg) : null,

          h(
            'div',
            { className: 'sfv-modal-foot' },
            h(
              'button',
              { type: 'button', className: 'sfv-btn sfv-primary', disabled: Boolean(busy) || !dir, onClick: doSync },
              busy === 'sync' ? '同步中…' : '立即同步',
            ),
            h('span', { className: 'sfv-spacer' }),
            h(
              'button',
              { type: 'button', className: 'sfv-btn', onClick: () => { if (props.onClose) props.onClose(); } },
              '关闭',
            ),
            h(
              'button',
              { type: 'button', className: 'sfv-btn', disabled: Boolean(busy), onClick: save },
              busy === 'save' ? '保存中…' : '保存设置',
            ),
          ),
        ),
      );
    }

    /* ============================================================ 面板容器 */

    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(error) {
        return { error: error };
      }
      componentDidCatch(error, info) {
        try {
          console.error('[session-file-vault] 面板渲染失败：', error, info);
        } catch (e) {
          /* ignore */
        }
      }
      render() {
        if (this.state && this.state.error) {
          return h(
            'div',
            { className: 'sfv-center' },
            h('div', { className: 'sfv-center-t sfv-err' }, '文件库面板出错了'),
            h('div', { className: 'sfv-center-s' }, String((this.state.error && this.state.error.message) || this.state.error)),
            h(
              'button',
              {
                type: 'button',
                className: 'sfv-btn',
                onClick: () => {
                  this.setState({ error: null });
                },
              },
              '重新渲染',
            ),
          );
        }
        return this.props.children;
      }
    }

    function PanelWithBoundary() {
      return h(PanelBoundary, null, h(Panel, null));
    }

    function Panel() {
      const [view, setView] = React.useState({ loading: true, error: null, data: null });
      const [busy, setBusy] = React.useState('');
      const [notice, setNotice] = React.useState('');
      const [filter, setFilter] = React.useState({ text: '', type: '', tags: [], from: '', to: '', sort: 'recent' });
      const [tagQuery, setTagQuery] = React.useState('');
      const [tagOpen, setTagOpen] = React.useState(false);
      const [openId, setOpenId] = React.useState('');
      const [details, setDetails] = React.useState({});
      const [mode, setMode] = React.useState('list');
      const [graphDim, setGraphDim] = React.useState('tag');
      // 脑图视口：{k,x,y} 对应 translate(x,y) scale(k)；拖拽 / 滚轮只改这里
      const [graphView, setGraphView] = React.useState({ k: 1, x: 0, y: 0 });
      // 列表列数 / 设置弹窗 / 刚保存的设置（live 优先于 /state 返回的那份）
      const [cols, setCols] = React.useState(readCols());
      const [settingsOpen, setSettingsOpen] = React.useState(false);
      const [liveSettings, setLiveSettings] = React.useState(null);
      const graphWrapRef = React.useRef(null);
      const graphDragRef = React.useRef(null);
      const graphMovedRef = React.useRef(false);

      const refresh = React.useCallback(() => {
        setView((prev) => ({ ...prev, loading: prev.data ? prev.loading : true, error: null }));
        return apiGet('/state')
          .then((data) => {
            setView({ loading: false, error: null, data: data });
            return data;
          })
          .catch((err) => {
            setView({ loading: false, error: (err && err.message) || String(err), data: null });
            return null;
          });
      }, []);

      React.useEffect(() => {
        refresh();
      }, [refresh]);

      const rebuilding = Boolean(view.data && view.data.rebuilding);
      const ready = Boolean(view.data && view.data.ready);

      // 索引未就绪 / 正在重建时轮询进度，建好后自动拉一次完整数据
      React.useEffect(() => {
        if (ready && !rebuilding) return undefined;
        let alive = true;
        const timer = setInterval(() => {
          apiGet('/status')
            .then((st) => {
              if (!alive) return;
              setView((prev) => {
                const base = prev.data || {};
                return {
                  ...prev,
                  loading: false,
                  data: {
                    ...base,
                    ready: Boolean(st.ready),
                    rebuilding: Boolean(st.rebuilding),
                    progress: st.progress || null,
                    lastError: st.lastError || null,
                  },
                };
              });
              if (st.ready && !st.rebuilding) refresh();
            })
            .catch(() => {
              /* 轮询失败不打扰用户，下一拍再试 */
            });
        }, 1000);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, [ready, rebuilding, refresh]);

      const reload = React.useCallback(() => {
        setBusy('reload');
        setNotice('');
        return refresh().then(() => setBusy(''));
      }, [refresh]);

      const rebuild = React.useCallback(() => {
        setBusy('rebuild');
        setNotice('');
        apiPost('/rebuild', {})
          .then((res) => {
            if (res && res.started === false) setNotice('已有一次重建正在进行，界面会跟随进度。');
            else setNotice('已开始重建索引，完成后列表会自动更新。');
            return refresh();
          })
          .catch((err) => setNotice('重建失败：' + ((err && err.message) || err)))
          .then(() => setBusy(''));
      }, [refresh]);

      const loadDetail = React.useCallback((id) => {
        setDetails((prev) => ({ ...prev, [id]: { loading: true, data: null, error: null } }));
        apiGet('/detail?id=' + encodeURIComponent(id))
          .then((res) => {
            setDetails((prev) => ({ ...prev, [id]: { loading: false, data: res.detail || res, error: null } }));
          })
          .catch((err) => {
            setDetails((prev) => ({ ...prev, [id]: { loading: false, data: null, error: (err && err.message) || String(err) } }));
          });
      }, []);

      const toggleRow = React.useCallback(
        (id) => {
          setOpenId((prev) => {
            if (prev === id) return '';
            loadDetail(id);
            return id;
          });
        },
        [loadDetail],
      );

      const onToggleTag = React.useCallback((tag) => {
        setFilter((prev) => {
          const cur = prev.tags || [];
          const next = cur.indexOf(tag) >= 0 ? cur.filter((t) => t !== tag) : cur.concat(tag);
          return { ...prev, tags: next };
        });
      }, []);

      // 点脑图上的文件圆点：切回列表并就地展开该行的详情
      const pickGraphFile = React.useCallback(
        (id) => {
          setMode('list');
          setOpenId(id);
          loadDetail(id);
        },
        [loadDetail],
      );

      const zoomGraphBy = React.useCallback((factor) => {
        setGraphView((prev) => zoomGraphView(prev, factor, GRAPH_CX, GRAPH_CX));
      }, []);

      const changeCols = React.useCallback((n) => {
        if (COLS_ALLOWED.indexOf(n) < 0) return;
        writeCols(n);
        setCols(n);
      }, []);

      // 收藏 / 取消收藏：写完立刻重拉 /state，让爱心与「手动同步」的集合保持一致
      const toggleFavorite = React.useCallback(
        (id, fav) => {
          apiPost('/favorite', { id: id, fav: Boolean(fav) })
            .then(() => refresh())
            .catch((err) => setNotice('收藏失败：' + ((err && err.message) || err)));
        },
        [refresh],
      );

      const onSettingsSaved = React.useCallback(
        (next) => {
          setLiveSettings(next || null);
          refresh();
        },
        [refresh],
      );

      const onSynced = React.useCallback(
        (report) => {
          if (!report) return;
          setNotice(
            '同步完成：复制 ' + report.copied + ' 个 · 更新 ' + report.updated + ' 个 · 跳过 ' + report.skipped + ' 个' +
              (report.failed ? ' · 失败 ' + report.failed + ' 个' : ''),
          );
          refresh();
        },
        [refresh],
      );

      const resetGraphView = React.useCallback(() => {
        setGraphView({ k: 1, x: 0, y: 0 });
      }, []);

      // 切换聚合维度时视图重排，复位视口（否则缩放位置会落在空白处）
      React.useEffect(() => {
        setGraphView({ k: 1, x: 0, y: 0 });
      }, [graphDim]);

      const startGraphPan = React.useCallback((ev) => {
        if (!ev) return;
        if (typeof ev.button === 'number' && ev.button !== 0) return;
        graphMovedRef.current = false;
        const x = typeof ev.clientX === 'number' ? ev.clientX : 0;
        const y = typeof ev.clientY === 'number' ? ev.clientY : 0;
        graphDragRef.current = { ox: x, oy: y, x: x, y: y, moved: false };
      }, []);

      // 拖动过的这一次 click 不算「点圆点」，否则会误触详情 / 筛选
      const suppressGraphClick = React.useCallback((ev) => {
        if (!graphMovedRef.current) return;
        graphMovedRef.current = false;
        if (ev) {
          if (ev.stopPropagation) ev.stopPropagation();
          if (ev.preventDefault) ev.preventDefault();
        }
      }, []);

      // 滚轮缩放：React 的 onWheel 是 passive 的，preventDefault 无效，
      // 所以这里用 ref 拿到真实 DOM 后手动挂非 passive 监听。
      React.useEffect(() => {
        if (mode !== 'graph') return undefined;
        if (typeof window === 'undefined') return undefined;
        const host = graphWrapRef.current;
        const el = host && host.querySelector ? host.querySelector('svg.sfv-graph') : null;
        if (!el || !el.addEventListener) return undefined;
        const onWheel = (ev) => {
          if (!ev) return;
          if (ev.preventDefault) ev.preventDefault();
          const delta = typeof ev.deltaY === 'number' && isFinite(ev.deltaY) ? ev.deltaY : 0;
          if (!delta) return;
          const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          const pt = screenToGraphPoint(rect, ev.clientX, ev.clientY);
          setGraphView((prev) => zoomGraphView(prev, Math.exp(-delta * GRAPH_ZOOM_WHEEL), pt.sx, pt.sy));
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
      }, [mode, ready]);

      // 拖拽平移：mousemove / mouseup 挂在 window 上，拖出画布也不会卡住
      React.useEffect(() => {
        if (mode !== 'graph') return undefined;
        if (typeof window === 'undefined') return undefined;
        const onMove = (ev) => {
          const drag = graphDragRef.current;
          if (!drag) return;
          let stepX = ev.clientX - drag.x;
          let stepY = ev.clientY - drag.y;
          if (!drag.moved) {
            const totalX = ev.clientX - drag.ox;
            const totalY = ev.clientY - drag.oy;
            if (Math.abs(totalX) + Math.abs(totalY) <= 3) return;
            drag.moved = true;
            stepX = totalX;
            stepY = totalY;
          }
          drag.x = ev.clientX;
          drag.y = ev.clientY;
          const host = graphWrapRef.current;
          const el = host && host.querySelector ? host.querySelector('svg.sfv-graph') : null;
          const rect = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
          const sc = graphScaleOf(rect);
          setGraphView((prev) => panGraphView(prev, stepX / sc, stepY / sc));
        };
        const onUp = () => {
          const drag = graphDragRef.current;
          if (drag && drag.moved) graphMovedRef.current = true;
          graphDragRef.current = null;
        };
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        return () => {
          window.removeEventListener('mousemove', onMove);
          window.removeEventListener('mouseup', onUp);
        };
      }, [mode]);

      return h(PanelView, {
        view: view,
        busy: busy,
        notice: notice,
        filter: filter,
        tagQuery: tagQuery,
        tagOpen: tagOpen,
        openId: openId,
        details: details,
        onReload: reload,
        onRebuild: rebuild,
        onText: (text) => setFilter((prev) => ({ ...prev, text: text })),
        onType: (type) => setFilter((prev) => ({ ...prev, type: type })),
        onToggleTag: onToggleTag,
        onTagQuery: (q) => {
          setTagQuery(q);
          setTagOpen(true);
        },
        onTagOpen: (open) => {
          setTagOpen(open);
          if (open) setTagQuery('');
        },
        onTagBlur: () => {
          setTimeout(() => setTagOpen(false), 120);
        },
        onFrom: (from) => setFilter((prev) => ({ ...prev, from: from })),
        onTo: (to) => setFilter((prev) => ({ ...prev, to: to })),
        onSort: (sort) => setFilter((prev) => ({ ...prev, sort: sort })),
        onClear: () => {
          setFilter({ text: '', type: '', tags: [], from: '', to: '', sort: 'recent' });
          setTagQuery('');
          setTagOpen(false);
        },
        onToggleRow: toggleRow,
        onLoadDetail: loadDetail,
        mode: mode,
        graphDim: graphDim,
        onMode: (next) => setMode(next === 'graph' ? 'graph' : 'list'),
        onGraphDim: (next) => setGraphDim(next === 'type' ? 'type' : 'tag'),
        onPickFile: pickGraphFile,
        graphView: graphView,
        graphRef: graphWrapRef,
        onGraphPanStart: startGraphPan,
        onGraphClickCapture: suppressGraphClick,
        onGraphZoom: zoomGraphBy,
        onGraphReset: resetGraphView,
        cols: cols,
        onCols: changeCols,
        settingsOpen: settingsOpen,
        onOpenSettings: () => setSettingsOpen(true),
        onCloseSettings: () => setSettingsOpen(false),
        settings: liveSettings,
        onFavorite: toggleFavorite,
        onSettingsSaved: onSettingsSaved,
        onSynced: onSynced,
      });
    }

    /* ============================================================ 槽位注册 */

    const LOG = '[session-file-vault]';

    /**
     * 每次 apply 递增一代；HMR 会重跑本 bundle 的 apply，而上一代注册还在槽位里
     * （重复注册会直接抛错），所以先 dispose 上一代再重新注册。
     */
    const HOT = { gen: 0, dispose: null };

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.register !== 'function') {
        console.warn(LOG + ' slots 服务不可用，跳过注册');
        return;
      }
      const myGen = ++HOT.gen;

      if (HOT.dispose) {
        try {
          HOT.dispose();
        } catch (e) {
          console.warn(LOG + ' 清理上一代注册失败', e);
        }
        HOT.dispose = null;
      }

      try {
        ensureStyle();
      } catch (e) {
        console.warn(LOG + ' 样式注入失败', e);
      }

      const disposers = [];

      // 侧边栏入口
      try {
        const un = ctx.slots.inject('sidebar.panellist', () => {
          if (myGen !== HOT.gen) return undefined;
          const dispose = ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: SIDEBAR_ORDER, label: LABEL },
            SidebarIcon,
          );
          disposers.push(dispose);
          return dispose;
        });
        disposers.push(un);
      } catch (e) {
        console.warn(LOG + ' 侧边栏入口注册失败（slot 未声明？）', e);
      }

      // 主面板
      try {
        const un = ctx.slots.inject('main', () => {
          if (myGen !== HOT.gen) return undefined;
          const dispose = ctx.slots.register({ name: 'main', key: PANEL_ID }, PanelWithBoundary);
          disposers.push(dispose);
          return dispose;
        });
        disposers.push(un);
      } catch (e) {
        console.warn(LOG + ' 主面板注册失败（slot 未声明？）', e);
      }

      HOT.dispose = () => {
        for (let i = disposers.length - 1; i >= 0; i -= 1) {
          try {
            disposers[i]();
          } catch (e) {
            /* disposer 本身要幂等，这里再兜一层 */
          }
        }
        disposers.length = 0;
      };
    }

    /* ============================================================ 测试钩子 */

    // 仅当宿主页面显式置 window.__SFV_TEST__ = true 时才暴露内部件（供离线渲染测试）。
    // 生产环境该全局不存在，因此这里不会向页面挂任何东西。
    try {
      if (typeof window !== 'undefined' && window.__SFV_TEST__) {
        window.__SFV_INTERNALS__ = {
          constants: { PANEL_ID, SIDEBAR_ORDER, API, STYLE_ID, LABEL, TYPE_ICON, SORT_MODES, GRAPH_SIZE, GRAPH_TAG_NONE, GRAPH_LABEL_MIN, GRAPH_DIM_LANE, GRAPH_R_DIM, GRAPH_ZOOM_MIN, GRAPH_ZOOM_MAX },
          CSS,
          ensureStyle,
          selectRecords,
          buildGraph,
          graphDimKeys,
          graphDimLabel,
          GraphView,
          clampGraphZoom,
          clampGraphView,
          zoomGraphView,
          panGraphView,
          graphScaleOf,
          screenToGraphPoint,
          graphTransformOf,
          PanelView,
          Panel,
          PanelWithBoundary,
          PanelBoundary,
          FileRow,
          FileDetail,
          TagPicker,
          TypeChips,
          SettingsModal,
          SidebarIcon,
          fmtSize,
          ymdOf,
          hmOf,
          relOf,
          stampOf,
          hueOf,
          tagStyle,
          typeStyle,
          TYPE_HUE,
          COLS_ALLOWED,
          SYNC_MODE_TEXT,
          readCols,
          writeCols,
          shortDir,
        };
      }
    } catch (e) {
      /* 测试钩子失败绝不影响插件 */
    }

    return { inject: ['slots'], apply };
  },
});

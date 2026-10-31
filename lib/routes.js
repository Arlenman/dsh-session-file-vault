/**
 * HTTP 路由：`/api/session-file-vault/*`。
 *
 * 走 DSH 的 connection.fetch.register —— 鉴权（Host/Origin + 浏览器会话 cookie）由
 * 宿主统一处理，客户端直接 fetch('/api/session-file-vault/...') 即可。
 *
 * 注册期硬约束（违反会直接抛错）：路径必须在 /api/ 下、每一段只能是
 * [A-Za-z0-9_$.-]、methods 非空不重复、同一路径只能注册一次。
 */

import { VaultError } from './vault.js';

export const ROUTE_PREFIX = '/api/session-file-vault';

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function jsonOk(payload) {
  return new Response(JSON.stringify({ ok: true, ...payload }), {
    status: 200,
    headers: JSON_HEADERS,
  });
}

function jsonFail(code, message, status = 400, extra = {}) {
  return new Response(
    JSON.stringify({ ok: false, error: { code, message: String(message ?? '未知错误') }, ...extra }),
    { status, headers: JSON_HEADERS },
  );
}

async function readJson(request) {
  const text = await request.text();
  if (text.trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new VaultError('bad-json', `请求体不是合法 JSON：${err.message}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new VaultError('bad-json', '请求体必须是 JSON 对象');
  }
  return parsed;
}

/** 统一收口：解析请求体 → 跑业务 → 包成 JSON 响应；异常转成可读错误。 */
function route(fn) {
  return async (request) => {
    try {
      const body = request.method === 'POST' ? await readJson(request) : {};
      return jsonOk(await fn(body, request));
    } catch (err) {
      if (err instanceof VaultError) {
        return jsonFail(err.code, err.message, err.status);
      }
      // 宿主日志里留一份堆栈，界面上只显示一行 —— 界面不该出现英文堆栈
      console.error('[dsh-session-file-vault] 路由失败：', err);
      return jsonFail('internal', err?.message ?? String(err), 500);
    }
  };
}

/**
 * @param {import('./vault.js').Vault} vault
 * @returns {Array<{path:string, methods:string[], requestBody:string, fetch:Function}>}
 */
export function createRoutes(vault) {
  return [
    // 全量状态：列表与脑图都吃这一份（144 条量级，客户端过滤，不做服务端分页）
    {
      path: `${ROUTE_PREFIX}/state`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: route(async () => vault.state()),
    },

    // 轻量运行状态（角标、轮询用，不含记录表）
    {
      path: `${ROUTE_PREFIX}/status`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: route(async () => vault.status()),
    },

    // 触发全量重建：后台跑，立即返回；已在跑则复用同一次
    {
      path: `${ROUTE_PREFIX}/rebuild`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        if (vault.running) {
          return { started: false, running: true, progress: vault.progress };
        }
        // 刻意不 await：全量扫描十几秒，HTTP 不该陪着等
        vault.rebuild({ persist: body.persist !== false }).catch((err) => {
          console.error('[dsh-session-file-vault] 后台重建失败：', err);
        });
        return { started: true, running: true };
      }),
    },

    // 轻量刷新：重查磁盘存在性 + 内容变化的重新打标签（不遍历会话日志）
    {
      path: `${ROUTE_PREFIX}/rescan`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        if (!vault.load()) {
          throw new VaultError('no-index', '索引还没建好，请先重建索引', 503);
        }
        const result = await vault.rescan({ persist: body.persist !== false });
        return { result, status: vault.status() };
      }),
    },

    // 编辑一条记录的三维标签（type / content / date）
    {
      path: `${ROUTE_PREFIX}/tags`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => {
        // userTags 必须显式给出（漏传即 bad-user-tags），避免误触发「清空三维」。
        const record = vault.updateTags(body.id, body.userTags);
        return { record };
      }),
    },

    // 单条详情（完整会话表 + 描述历史），右侧预览面板用
    {
      path: `${ROUTE_PREFIX}/detail`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: route(async (_body, request) => {
        const url = new URL(request.url, 'http://localhost');
        return { detail: vault.detail(url.searchParams.get('id') ?? '') };
      }),
    },

    // 同步设置：GET 读取，POST 局部更新（PATCH 语义，只处理出现过的字段）
    {
      path: `${ROUTE_PREFIX}/settings`,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: route(async (body, request) => {
        if (request.method === 'GET') return { settings: vault.settingsView() };
        return { settings: vault.updateSettings(body) };
      }),
    },

    // 收藏 / 取消收藏（手动同步模式下就是要同步的那批文件）
    {
      path: `${ROUTE_PREFIX}/favorite`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async (body) => vault.setFavorite(body.id, body.fav === true || body.favorite === true)),
    },

    // 按当前设置把文件复制一份到同步目录
    {
      path: `${ROUTE_PREFIX}/sync`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: route(async () => ({ report: vault.sync() })),
    },
  ];
}

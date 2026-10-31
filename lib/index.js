/**
 * dsh-session-file-vault · 宿主半边
 *
 * 职责只有三件：
 *   1. 插件加载时在后台把索引建好（不阻塞 apply）；
 *   2. 把服务层挂到 `/api/session-file-vault/*` 上；
 *   3. 插件卸载时叫停后台扫描。
 *
 * 静态 inject 留空 —— 这样 connection 服务缺失时插件也不会卡在 pending，
 * 而是「索引照建、路由缺席」（服务用 ctx.inject 懒解析）。
 */

import { Vault } from './vault.js';
import { createRoutes } from './routes.js';

export const name = 'dsh-session-file-vault';

/** 宿主服务：一个都不硬依赖，全部懒解析。 */
export const inject = [];

const LOG = '[dsh-session-file-vault]';

/**
 * @param {any} ctx 宿主 Cordis Context
 */
export function apply(ctx) {
  const vault = new Vault();

  // 索引在插件加载后立刻开始建：用户打开面板时通常已经好了。
  // 全量扫描约十几秒，所以绝不能 await 在 apply 里。
  try {
    ctx.effect(() => {
      let alive = true;
      vault
        .ensure()
        .then((index) => {
          if (!alive || !index) return;
          const stats = index.stats ?? {};
          console.log(
            `${LOG} 索引就绪：${index.records.length} 个文件` +
              `（扫描 ${stats.scanMs ?? '?'}ms，缺失 ${stats.missingCount ?? '?'} 个）`,
          );
        })
        .catch((err) => {
          console.error(`${LOG} 建索引失败：${err?.message ?? err}`);
        });
      return () => {
        alive = false;
        vault.requestStop();
      };
    }, 'dsh-session-file-vault: index');
  } catch (err) {
    console.error(`${LOG} 索引任务挂载失败：${err?.message ?? err}`);
  }

  ctx.inject(['connection'], (c) => {
    const connection = c.get('connection');
    const register =
      typeof connection?.fetch?.register === 'function'
        ? connection.fetch.register.bind(connection.fetch)
        : undefined;

    if (register === undefined) {
      console.error(`${LOG} connection.fetch.register 不可用，面板接口未注册`);
      return;
    }

    let registered = 0;
    for (const r of createRoutes(vault)) {
      try {
        // registerFetchRoute 自己会 owner.effect(...) 包一层；这里再包一层，
        // 让插件卸载时路由跟着走（与 dsh-context 的写法一致）。
        c.effect(() => register(r), `dsh-session-file-vault: ${r.path}`);
        registered += 1;
      } catch (err) {
        console.error(`${LOG} 路由 ${r.path} 注册失败：${err?.message ?? err}`);
      }
    }
    console.log(`${LOG} 已注册 ${registered} 条接口`);
  });
}

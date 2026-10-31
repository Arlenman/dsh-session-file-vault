/**
 * 路径解析 —— 自己算 DSH_HOME，不从内核 import。
 *
 * 内核的 `@deepseek-ai/dsh-home-paths` 里 `resolveDshHome(configured, env)` 的语义是：
 * 显式配置 > 非空 `DSH_HOME` 环境变量 > `~/.dsh`。这里复刻同一套优先级，
 * 但不依赖那个包（插件装出来只有自己这一份代码，跨 profile 解析内核包不可靠）。
 *
 * 本机实测 `DSH_HOME=C:\Users\98340\.dsh`，与 `homedir()/.dsh` 一致。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * @param {string|undefined} configured 显式配置的 DSH_HOME（插件 config 传入）
 * @param {Record<string,string|undefined>} [env]
 * @returns {string}
 */
export function resolveDshHome(configured, env = process.env) {
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  const fromEnv = typeof env?.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (fromEnv) return fromEnv;
  return join(homedir(), '.dsh');
}

/**
 * 本插件用到的全部路径。
 * @param {string} dshHome
 */
export function vaultPaths(dshHome) {
  const vaultDir = join(dshHome, 'session-file-vault');
  return {
    dshHome,
    vaultDir,
    indexPath: join(vaultDir, 'index.json'),
    scanStatePath: join(vaultDir, 'scan-state.json'),
    // 同步设置 + 收藏 + 已同步文件名映射（用户数据，重建索引不碰它）
    settingsPath: join(vaultDir, 'settings.json'),
    sessionsRoot: join(dshHome, 'sessions'),
  };
}

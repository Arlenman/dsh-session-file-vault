/**
 * 带 code 的业务错误。
 *
 * 单独一个模块是为了打破循环依赖：sync.js 要用它，vault.js 也要用它，
 * 而 vault.js 又 import sync.js。routes.js 仍从 vault.js 里 import（那边 re-export）。
 */
export class VaultError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    this.status = status;
  }
}

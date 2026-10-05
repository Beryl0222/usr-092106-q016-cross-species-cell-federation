/** 治理违例与并发冲突的统一错误类型。 */
export class GovernanceError extends Error {
  /**
   * @param {string} code 机器可读错误码
   * @param {string} message 中文说明
   * @param {Record<string, unknown>} [details] 附加上下文
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GovernanceError";
    this.code = code;
    this.details = details;
  }
}

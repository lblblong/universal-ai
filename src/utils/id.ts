/** 生成消息 / 会话 ID：优先 crypto.randomUUID，兜底时间戳 + 随机数 */
export function generateId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

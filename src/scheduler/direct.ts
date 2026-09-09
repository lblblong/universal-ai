import type { UIMessage } from '../types/message'
import type { StreamScheduler } from './types'

/**
 * 直通流调度器：收到每个 chunk 立即提交，不进行任何排队或插值。
 * 适用于 Node.js 脚本、无需动画或单元测试环境。
 */
export function createDirectScheduler<UI_MESSAGE extends UIMessage = UIMessage>(): StreamScheduler<UI_MESSAGE> {
  return {
    push(message, commit) {
      commit(message)
    },
    flush(message, commit) {
      commit(message)
    },
  }
}


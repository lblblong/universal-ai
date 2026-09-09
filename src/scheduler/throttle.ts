import type { UIMessage } from '../types/message'
import type { StreamScheduler, ThrottleSchedulerOptions } from './types'

/**
 * 节流流调度器：
 * 将密集的流式 chunks 按指定时间窗口（默认 50ms）合并派发。
 * 首个 chunk 默认立即派发（leading: true）以获得即时首字反馈；
 * 过程中的 updates 走节流合并；flush 时立即清空并提交最终快照。
 */
export function createThrottleScheduler<UI_MESSAGE extends UIMessage = UIMessage>(
  options: ThrottleSchedulerOptions = {},
): StreamScheduler<UI_MESSAGE> {
  const waitMs = options.waitMs ?? 50
  const leading = options.leading ?? true

  let timer: ReturnType<typeof setTimeout> | undefined
  let pendingMessage: UI_MESSAGE | undefined
  let lastCommitTime = 0

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  return {
    push(message, commit) {
      // waitMs <= 0 时直接直通
      if (waitMs <= 0) {
        commit(message)
        return
      }

      const now = Date.now()
      const remaining = waitMs - (now - lastCommitTime)

      if (leading && remaining <= 0) {
        clearTimer()
        lastCommitTime = now
        pendingMessage = undefined
        commit(message)
        return
      }

      pendingMessage = message
      if (!timer) {
        const delay = remaining > 0 ? remaining : waitMs
        timer = setTimeout(() => {
          timer = undefined
          lastCommitTime = Date.now()
          if (pendingMessage) {
            const next = pendingMessage
            pendingMessage = undefined
            commit(next)
          }
        }, delay)
      }
    },

    flush(message, commit) {
      clearTimer()
      pendingMessage = undefined
      lastCommitTime = Date.now()
      commit(message)
    },

    reset() {
      clearTimer()
      pendingMessage = undefined
      lastCommitTime = 0
    },
  }
}


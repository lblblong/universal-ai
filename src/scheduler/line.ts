import type { UIMessage, UIMessagePart } from '../types/message'
import type { LineSchedulerOptions, StreamScheduler } from './types'

/**
 * 按行缓冲流调度器：
 * 适合代码块、列表、表格及结构化 Markdown 输出。
 * 只有当产生完整换行符（\n）时才提交整行；
 * 提供超长单行字符兜底（maxLineChars，默认 120 字符）；
 * 非纯文本 part（如工具调用）直接透传；
 * flush 时立即提交最后一行未闭合的全部内容。
 */
export function createLineScheduler<UI_MESSAGE extends UIMessage = UIMessage>(
  options: LineSchedulerOptions = {},
): StreamScheduler<UI_MESSAGE> {
  const maxLineChars = Math.max(20, options.maxLineChars ?? 120)
  const throttleMs = Math.max(0, options.throttleMs ?? 0)

  let lastCommitTime = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let pendingSnapshot: UI_MESSAGE | undefined

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const buildLineSnapshot = (source: UI_MESSAGE): UI_MESSAGE => {
    const nextParts: UIMessagePart[] = []

    for (let i = 0; i < (source.parts || []).length; i++) {
      const part = source.parts[i]
      const isTextType = part.type === 'text' || (part as any).type === 'reasoning'

      if (!isTextType) {
        nextParts.push({ ...part })
        continue
      }

      const fullText = (part as any).text ?? ''
      const lastNewlineIndex = fullText.lastIndexOf('\n')

      if (lastNewlineIndex !== -1) {
        // 截止到最后一个完整换行符（包含换行本身）
        nextParts.push({
          ...part,
          text: fullText.slice(0, lastNewlineIndex + 1),
        } as UIMessagePart)
      } else if (fullText.length >= maxLineChars) {
        // 单行超长兜底，避免长时间不刷新
        nextParts.push({
          ...part,
          text: fullText,
        } as UIMessagePart)
      } else {
        // 第一行还没换行且长度未达到兜底值，若为空则显示空
        nextParts.push({
          ...part,
          text: fullText.slice(0, 1),
        } as UIMessagePart)
      }
    }

    return {
      ...source,
      parts: nextParts,
    }
  }

  return {
    push(message, commit) {
      const snapshot = buildLineSnapshot(message)

      if (throttleMs <= 0) {
        commit(snapshot)
        return
      }

      const now = Date.now()
      if (now - lastCommitTime >= throttleMs) {
        clearTimer()
        lastCommitTime = now
        commit(snapshot)
      } else {
        pendingSnapshot = snapshot
        if (!timer) {
          timer = setTimeout(() => {
            timer = undefined
            lastCommitTime = Date.now()
            if (pendingSnapshot) {
              const s = pendingSnapshot
              pendingSnapshot = undefined
              commit(s)
            }
          }, throttleMs - (now - lastCommitTime))
        }
      }
    },

    flush(message, commit) {
      clearTimer()
      pendingSnapshot = undefined
      commit(message)
    },

    reset() {
      clearTimer()
      pendingSnapshot = undefined
      lastCommitTime = 0
    },
  }
}

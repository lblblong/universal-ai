import type { UIMessage, UIMessagePart } from '../types/message'
import type { SmoothSchedulerOptions, StreamScheduler } from './types'

/**
 * 跨平台下一帧调度：优先 requestAnimationFrame，Node/测试环境降级为 setTimeout
 */
const scheduleNextFrame =
  typeof requestAnimationFrame !== 'undefined'
    ? (cb: () => void) => requestAnimationFrame(cb)
    : (cb: () => void) => setTimeout(cb, 16)

const cancelFrame =
  typeof cancelAnimationFrame !== 'undefined'
    ? (id: any) => cancelAnimationFrame(id)
    : (id: any) => clearTimeout(id)

/**
 * 平滑打字机流调度器：
 * 将突发、抖动的流式文本块按设定的字符速率（默认 40 cps）匀速平滑展现；
 * 内置缓冲区积压自动加速追赶（catch-up）机制；
 * 非纯文本部分（如 tool-call、file）立即透传，不拖延业务逻辑执行；
 * flush 时立即瞬间清空缓冲区并交付完整消息。
 */
export function createSmoothScheduler<UI_MESSAGE extends UIMessage = UIMessage>(
  options: SmoothSchedulerOptions = {},
): StreamScheduler<UI_MESSAGE> {
  const baseCps = Math.max(1, options.cps ?? 40)
  const catchUpThreshold = Math.max(10, options.catchUpThreshold ?? 80)
  const maxCatchUpFactor = Math.max(1, options.maxCatchUpFactor ?? 4)

  let frameId: any = undefined
  let lastFrameTime = 0
  let charAccumulator = 0
  let targetMessage: UI_MESSAGE | undefined
  let latestCommit: ((msg: UI_MESSAGE) => void) | undefined

  // 记录每个 part 索引当前已展示的文本字符长度
  const displayedCharCounts: number[] = []

  const stopLoop = () => {
    if (frameId !== undefined) {
      cancelFrame(frameId)
      frameId = undefined
    }
  }

  /**
   * 构造当前进度下的可见消息快照
   */
  const buildProgressSnapshot = (source: UI_MESSAGE): { snapshot: UI_MESSAGE; hasRemaining: boolean } => {
    let hasRemaining = false
    const nextParts: UIMessagePart[] = []

    for (let i = 0; i < (source.parts || []).length; i++) {
      const part = source.parts[i]
      const isTextType = part.type === 'text' || (part as any).type === 'reasoning'

      if (!isTextType) {
        // 非纯文本 part（如工具调用、文件附件等）直接原样完整保留
        nextParts.push({ ...part })
        continue
      }

      const fullText = (part as any).text ?? ''
      const targetLen = fullText.length
      const currentDisplayed = displayedCharCounts[i] ?? 0

      if (currentDisplayed < targetLen) {
        hasRemaining = true
        nextParts.push({
          ...part,
          text: fullText.slice(0, currentDisplayed),
        } as UIMessagePart)
      } else {
        nextParts.push({
          ...part,
          text: fullText,
        } as UIMessagePart)
      }
    }

    return {
      snapshot: {
        ...source,
        parts: nextParts,
      },
      hasRemaining,
    }
  }

  const loop = () => {
    frameId = undefined
    if (!targetMessage || !latestCommit) return

    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    const deltaMs = lastFrameTime ? Math.min(100, Math.max(1, now - lastFrameTime)) : 16
    lastFrameTime = now

    // 计算当前正在推进的 part 及其积压量
    let activePartIndex = -1
    let backlog = 0

    for (let i = 0; i < (targetMessage.parts || []).length; i++) {
      const part = targetMessage.parts[i]
      if (part.type === 'text' || (part as any).type === 'reasoning') {
        const fullLen = ((part as any).text || '').length
        const curr = displayedCharCounts[i] ?? 0
        if (curr < fullLen) {
          activePartIndex = i
          backlog = fullLen - curr
          break
        }
      }
    }

    if (activePartIndex !== -1) {
      // 计算加速追赶系数：积压越多，速度越快
      let speedFactor = 1
      if (backlog > catchUpThreshold) {
        speedFactor = Math.min(
          maxCatchUpFactor,
          1 + (backlog - catchUpThreshold) / catchUpThreshold,
        )
      }

      const effectiveCps = baseCps * speedFactor
      charAccumulator += (effectiveCps * deltaMs) / 1000

      const charsToAdd = Math.floor(charAccumulator)
      if (charsToAdd > 0) {
        charAccumulator -= charsToAdd
        const prevCount = displayedCharCounts[activePartIndex] ?? 0
        const fullLen = ((targetMessage.parts[activePartIndex] as any).text || '').length
        displayedCharCounts[activePartIndex] = Math.min(fullLen, prevCount + charsToAdd)
      }
    }

    const { snapshot, hasRemaining } = buildProgressSnapshot(targetMessage)
    latestCommit(snapshot)

    if (hasRemaining) {
      frameId = scheduleNextFrame(loop)
    }
  }

  return {
    push(message, commit) {
      targetMessage = message
      latestCommit = commit

      // 初始化各 part 长度记录
      while (displayedCharCounts.length < (message.parts || []).length) {
        displayedCharCounts.push(0)
      }

      // 如果未启动帧循环，立即启动
      if (frameId === undefined) {
        lastFrameTime = typeof performance !== 'undefined' ? performance.now() : Date.now()
        // 首字若尚未展现，预置首字符直接呈现以保证首字响应
        if (displayedCharCounts[0] === 0 && (message.parts || []).length > 0) {
          const first = message.parts[0]
          if ((first.type === 'text' || (first as any).type === 'reasoning') && (first as any).text?.length > 0) {
            displayedCharCounts[0] = 1
            const { snapshot } = buildProgressSnapshot(message)
            commit(snapshot)
          }
        }
        frameId = scheduleNextFrame(loop)
      }
    },

    flush(message, commit) {
      stopLoop()
      targetMessage = undefined
      latestCommit = undefined
      charAccumulator = 0
      displayedCharCounts.length = 0
      commit(message)
    },

    reset() {
      stopLoop()
      targetMessage = undefined
      latestCommit = undefined
      charAccumulator = 0
      displayedCharCounts.length = 0
    },
  }
}

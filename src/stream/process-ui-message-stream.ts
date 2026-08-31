import type { UIMessageChunk } from '../types/chunk'
import {
  getToolName,
  type ReasoningUIPart,
  type StaticToolUIPart,
  type TextUIPart,
  type ToolUIPart,
  type UIMessage,
  type UIMessagePart,
} from '../types/message'

/**
 * 流处理器的可变状态：当前 assistant 消息 + 活动部件的索引。
 * 复刻 AI SDK processUIMessageStream 对协议子集的归约语义。
 */
export interface UIMessageStreamState<UI_MESSAGE extends UIMessage> {
  message: UI_MESSAGE
  finishReason?: unknown
  aborted?: boolean
}

export interface ProcessUIMessageStreamOptions<UI_MESSAGE extends UIMessage> {
  /** 持有 message 引用的可变状态，处理器原地更新 message.parts */
  state: UIMessageStreamState<UI_MESSAGE>
  /**
   * 服务端声明的工具调用（tool-input-available 且非 providerExecuted）时触发。
   * 与 AI SDK 一致：处理器会 await 该回调；回调内不要 await addToolOutput，
   * 否则与流处理互等死锁——fire-and-forget 调用即可。
   */
  onToolCall?: (options: { toolCall: { toolCallId: string; toolName: string; input: unknown } }) => void | PromiseLike<void>
  /** 未知/不支持 chunk 的观测点，默认忽略 */
  onUnknownChunk?: (chunk: UIMessageChunk) => void
}

function isTextPart(part: UIMessagePart): part is TextUIPart {
  return part.type === 'text'
}

function isToolPart(part: UIMessagePart): part is ToolUIPart {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

function upsertActivePart<T extends TextUIPart | ReasoningUIPart>(
  map: Map<string, T>,
  parts: UIMessagePart[],
  id: string,
  create: () => T,
): T {
  let part = map.get(id)
  if (!part) {
    part = create()
    map.set(id, part)
    parts.push(part)
  }
  return part
}

function closeActivePart<T extends { state?: 'streaming' | 'done' }>(map: Map<string, T>, id: string) {
  const part = map.get(id)
  if (part) {
    part.state = 'done'
    map.delete(id)
  }
}

/**
 * 把 UI message stream 的 chunk 归约进 state.message。
 * 返回直通流，便于上层同时观察原始 chunk（如统计/调试）。
 *
 * 容错策略：text/reasoning-delta 先于对应 *-start 到达时自动补开 part；
 * 未知 chunk 静默忽略（通过 onUnknownChunk 观测）。
 */
export function processUIMessageStream<UI_MESSAGE extends UIMessage>(
  options: ProcessUIMessageStreamOptions<UI_MESSAGE>,
): TransformStream<UIMessageChunk, UIMessageChunk> {
  const { state, onToolCall, onUnknownChunk } = options
  const activeTextParts = new Map<string, TextUIPart>()
  const activeReasoningParts = new Map<string, ReasoningUIPart>()
  const pendingToolInputs = new Map<string, string>()

  const findPartIndex = (predicate: (part: UIMessagePart) => boolean) =>
    state.message.parts.findIndex(predicate)

  const findToolPart = (toolCallId: string): ToolUIPart | undefined => {
    for (const part of state.message.parts) {
      if (isToolPart(part) && part.toolCallId === toolCallId) return part
    }
    return undefined
  }

  const replaceToolPart = (toolCallId: string, next: ToolUIPart) => {
    const index = findPartIndex((part) => isToolPart(part) && part.toolCallId === toolCallId)
    if (index !== -1) state.message.parts[index] = next
    else state.message.parts.push(next)
  }

  const makeToolPart = (
    chunk: { toolCallId: string; toolName: string; providerExecuted?: boolean; dynamic?: boolean },
    partState: 'input-streaming' | 'input-available',
    input: unknown,
  ): ToolUIPart => {
    const base = {
      toolCallId: chunk.toolCallId,
      providerExecuted: chunk.providerExecuted,
      state: partState,
      input,
    }
    return chunk.dynamic
      ? { type: 'dynamic-tool', toolName: chunk.toolName, ...base }
      : { type: `tool-${chunk.toolName}` as StaticToolUIPart['type'], ...base }
  }

  return new TransformStream<UIMessageChunk, UIMessageChunk>({
    async transform(chunk, controller) {
      switch (chunk.type) {
        case 'start': {
          if (chunk.messageId) state.message = { ...state.message, id: chunk.messageId }
          break
        }

        case 'start-step': {
          state.message.parts.push({ type: 'step-start' })
          break
        }

        case 'text-start': {
          upsertActivePart(activeTextParts, state.message.parts, chunk.id, () => ({
            type: 'text',
            text: '',
            state: 'streaming',
          }))
          break
        }

        case 'text-delta': {
          // 容错：正常协议里 text-start 先行；缺失时自动补开，避免丢字
          const part = upsertActivePart(activeTextParts, state.message.parts, chunk.id, () => ({
            type: 'text',
            text: '',
            state: 'streaming',
          }))
          part.text += chunk.delta
          break
        }

        case 'text-end': {
          closeActivePart(activeTextParts, chunk.id)
          break
        }

        case 'reasoning-start': {
          upsertActivePart(activeReasoningParts, state.message.parts, chunk.id, () => ({
            type: 'reasoning',
            id: chunk.id,
            text: '',
            state: 'streaming',
          }))
          break
        }

        case 'reasoning-delta': {
          // 与 text-delta 同样容错：缺 start 时自动补开，避免丢思考内容
          const part = upsertActivePart(activeReasoningParts, state.message.parts, chunk.id, () => ({
            type: 'reasoning',
            id: chunk.id,
            text: '',
            state: 'streaming',
          }))
          part.text += chunk.delta
          break
        }

        case 'reasoning-end': {
          closeActivePart(activeReasoningParts, chunk.id)
          break
        }

        case 'tool-input-start': {
          pendingToolInputs.set(chunk.toolCallId, '')
          replaceToolPart(chunk.toolCallId, makeToolPart(chunk, 'input-streaming', ''))
          break
        }

        case 'tool-input-delta': {
          const accumulated = (pendingToolInputs.get(chunk.toolCallId) ?? '') + chunk.inputTextDelta
          pendingToolInputs.set(chunk.toolCallId, accumulated)
          const part = findToolPart(chunk.toolCallId)
          if (part) part.input = accumulated
          break
        }

        case 'tool-input-available': {
          pendingToolInputs.delete(chunk.toolCallId)
          replaceToolPart(chunk.toolCallId, makeToolPart(chunk, 'input-available', chunk.input))

          // 与 AI SDK 一致：阻塞式触发 onToolCall（provider 已执行的除外）
          if (onToolCall && !chunk.providerExecuted) {
            await onToolCall({
              toolCall: {
                toolCallId: chunk.toolCallId,
                toolName: chunk.toolName,
                input: chunk.input,
              },
            })
          }
          break
        }

        case 'tool-output-available':
        case 'tool-output-error': {
          const part = findToolPart(chunk.toolCallId)
          if (part) {
            part.state = chunk.type === 'tool-output-available' ? 'output-available' : 'output-error'
            if ('output' in chunk) part.output = chunk.output
            if ('errorText' in chunk) part.errorText = chunk.errorText
          }
          break
        }

        case 'error': {
          throw new Error(chunk.errorText)
        }

        case 'abort': {
          state.aborted = true
          break
        }

        case 'finish': {
          state.finishReason = chunk.finishReason
          break
        }

        // finish-step 只是步骤边界标记，不影响消息形状
        case 'finish-step': {
          break
        }

        default: {
          onUnknownChunk?.(chunk)
        }
      }

      controller.enqueue(chunk)
    },
    flush() {
      // 流意外中断时，把悬挂的 streaming 状态收敛为 done，避免 UI 永久转圈
      for (const part of activeTextParts.values()) part.state = 'done'
      activeTextParts.clear()
      for (const part of activeReasoningParts.values()) part.state = 'done'
      activeReasoningParts.clear()
    },
  })
}

/** 从部件列表提取纯文本（测试与调试用） */
export function textOf(message: UIMessage): string {
  return message.parts
    .filter(isTextPart)
    .map((part) => part.text)
    .join('')
}

/** 工具部件名导出便捷引用，避免调用方重复 import 两个模块 */
export { getToolName }

/**
 * UI message stream 的 chunk 类型。
 *
 * 这里只定义 universal-ai 实际处理的服务端协议子集（AI SDK toUIMessageStream
 * 会发更多种 chunk，我们的服务端只用到其中一部分）；遇到未知 chunk 类型时
 * 处理器会静默忽略，保证服务端升级新增字段/类型时不炸客户端。
 */

export type UIMessageChunk =
  | { type: 'start'; messageId?: string }
  | { type: 'start-step' }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'reasoning-start'; id: string }
  | { type: 'reasoning-delta'; id: string; delta: string }
  | { type: 'reasoning-end'; id: string }
  | {
      type: 'tool-input-start'
      toolCallId: string
      toolName: string
      providerExecuted?: boolean
      dynamic?: boolean
    }
  | { type: 'tool-input-delta'; toolCallId: string; inputTextDelta: string }
  | {
      type: 'tool-input-available'
      toolCallId: string
      toolName: string
      input: unknown
      providerExecuted?: boolean
      dynamic?: boolean
    }
  | {
      type: 'tool-output-available'
      toolCallId: string
      output: unknown
      providerExecuted?: boolean
    }
  | { type: 'tool-output-error'; toolCallId: string; errorText: string }
  | { type: 'error'; errorText: string }
  | { type: 'finish-step' }
  | { type: 'finish'; finishReason?: unknown }
  | { type: 'abort' }

import type { UIMessageChunk } from './chunk'
import type { UIMessage as UIMessageType } from './message'

export type { UIMessageChunk }

/** Chat 的钩子状态：ready / 已提交等待流 / 正在流式 / 出错 */
export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'

/**
 * AbstractChat 与流处理器之间的共享状态契约。
 * UniversalChatState 实现它以对接宿主框架的响应式系统。
 */
export interface ChatState<UI_MESSAGE extends UIMessageType> {
  status: ChatStatus
  error: Error | undefined
  messages: UI_MESSAGE[]
  pushMessage: (message: UI_MESSAGE) => void
  popMessage: () => void
  replaceMessage: (index: number, message: UI_MESSAGE) => void
  snapshot: <T>(value: T) => T
}

export type ChatOnErrorCallback = (error: Error) => void

export type ChatOnToolCallCallback = (options: {
  toolCall: {
    toolCallId: string
    toolName: string
    input: unknown
  }
}) => void | PromiseLike<void>

export type ChatOnFinishCallback<UI_MESSAGE extends UIMessageType> = (options: {
  message: UI_MESSAGE
  messages: UI_MESSAGE[]
  isAbort: boolean
  isError: boolean
  finishReason?: unknown
}) => void

export interface ChatRequestOptions {
  body?: Record<string, unknown>
  headers?: Record<string, string> | Headers
}

export interface ChatInit<UI_MESSAGE extends UIMessageType> {
  /** 会话唯一标识，未提供时自动生成 */
  id?: string
  transport?: ChatTransport<UI_MESSAGE>
  onError?: ChatOnErrorCallback
  onToolCall?: ChatOnToolCallCallback
  onFinish?: ChatOnFinishCallback<UI_MESSAGE>
  /**
   * 流结束或工具输出补齐后调用，返回 true 时自动携带当前消息重新请求
   * （客户端工具续跑、服务端兜底续跑都靠它驱动）。
   */
  sendAutomaticallyWhen?: (options: { messages: UI_MESSAGE[] }) => boolean | PromiseLike<boolean>
}

export interface ChatTransportSendOptions<UI_MESSAGE extends UIMessageType> {
  id: string
  messages: UI_MESSAGE[]
  trigger: ChatSendTrigger
  messageId?: string
  body?: Record<string, unknown>
  headers?: Record<string, string> | Headers
  credentials?: RequestCredentials
  abortSignal?: AbortSignal
  fetch?: typeof globalThis.fetch
}

export interface ChatTransport<UI_MESSAGE extends UIMessageType> {
  sendMessages: (options: ChatTransportSendOptions<UI_MESSAGE>) => Promise<ReadableStream<UIMessageChunk>>
}

export type ChatSendTrigger = 'submit-message' | 'regenerate-message'

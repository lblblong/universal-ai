// Chat：状态机 + 流渲染 + 客户端工具回路
export { Chat } from './chat/chat'
export type { ChatOptions, ChatTool } from './chat/chat'
export { UniversalChatState } from './chat/chat-state'
export { lastAssistantMessageIsCompleteWithToolCalls } from './chat/last-assistant-message-is-complete-with-tool-calls'

// 无 Chat 状态的单次补全调用
export { callCompletion } from './completion/call-completion'

// 会话历史适配器
export {
  createServerHistoryAdapter,
  createLocalHistoryAdapter,
} from './adapter'
export type {
  ChatAdapter,
  ChatSendTrigger,
  LocalHistoryPersist,
} from './adapter'

// 传输层（自定义端点 / 代理时使用）
export { DefaultChatTransport } from './transport/http-chat-transport'
export type { DefaultChatTransportOptions, Resolvable } from './transport/http-chat-transport'

// 流处理（调试 / 自定义渲染时使用）
export { processUIMessageStream, textOf } from './stream/process-ui-message-stream'

// SSE / JSON 事件流解析（独立复用）
export { parseJsonEventStream, createEventSourceParserStream } from './sse/export'
export type { ParseResult } from './sse/export'
export type { EventSourceMessage } from './sse/export'

// 类型
export type {
  ChatStatus,
  ChatState,
  ChatInit,
  ChatRequestOptions,
  ChatTransport,
  ChatOnErrorCallback,
  ChatOnToolCallCallback,
  ChatOnFinishCallback,
  UIMessageChunk,
} from './types/chat'
export type {
  UIMessage,
  UIMessagePart,
  TextUIPart,
  StepStartUIPart,
  ToolUIPart,
  FileUIPart,
  DynamicToolUIPart,
  StaticToolUIPart,
  ToolUIPartState,
} from './types/message'
export { isToolUIPart, getToolName } from './types/message'
export { generateId } from './utils/id'

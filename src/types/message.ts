/**
 * UIMessage / 消息部件类型。
 *
 * 形状与 Vercel AI SDK 的 UI Messages 协议保持一致：
 * 服务端（ai 包 toUIMessageStream 生成的流）与客户端（本库序列化回传的消息）
 * 两端都按该协议解析，因此零依赖客户端可以无损对接 AI SDK 服务端。
 */

export type TextUIPart = {
  type: 'text'
  text: string
  /** 流式期间为 'streaming'，text-end 后为 'done' */
  state?: 'streaming' | 'done'
}

export type StepStartUIPart = {
  type: 'step-start'
}

/** 工具调用在 UI 上的生命周期 */
export type ToolUIPartState =
  | 'input-streaming'
  | 'input-available'
  | 'output-available'
  | 'output-error'

/**
 * 动态工具部件（工具名不在静态类型集里时的通用形状）。
 */
export type DynamicToolUIPart = {
  type: 'dynamic-tool'
  toolName: string
  toolCallId: string
  providerExecuted?: boolean
  state: ToolUIPartState
  /** input-streaming 阶段是累积的原始参数文本，input-available 后是解析好的对象 */
  input?: unknown
  output?: unknown
  errorText?: string
}

/**
 * 静态工具部件：工具名编码在 type 里（`tool-${toolName}`）。
 * 注意：与 AI SDK 一致，静态形状不含 toolName 字段（名字从 type 推导）。
 */
export type StaticToolUIPart = {
  type: `tool-${string}`
  toolCallId: string
  providerExecuted?: boolean
  state: ToolUIPartState
  input?: unknown
  output?: unknown
  errorText?: string
}

export type ToolUIPart = DynamicToolUIPart | StaticToolUIPart

/**
 * 文件部件：对齐 AI SDK 的 FileUIPart。
 * universal-ai 的流处理器不消费 file 部件，但消息可以携带它直传给服务端处理
 * （如图片输入）。
 */
export type FileUIPart = {
  type: 'file'
  /** 完整 IANA 类型（image/png）或顶层段（image） */
  mediaType: string
  filename?: string
  /** 文件 URL（托管地址或 Data URL） */
  url: string
  /** 上传文件后各 provider 的引用映射 */
  providerReference?: Record<string, string>
}

export type UIMessagePart = TextUIPart | StepStartUIPart | ToolUIPart | FileUIPart

export interface UIMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  parts: UIMessagePart[]
}

/** 判断部件是否为工具部件（静态或动态），并收窄类型 */
export function isToolUIPart(part: UIMessagePart): part is ToolUIPart {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-')
}

/** 取工具部件的工具名（静态形状从 type 推导） */
export function getToolName(part: ToolUIPart): string {
  return part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length)
}

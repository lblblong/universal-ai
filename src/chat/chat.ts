import type { ChatAdapter } from '../adapter'
import { processUIMessageStream, type UIMessageStreamState } from '../stream/process-ui-message-stream'
import { DefaultChatTransport, resolveResolvable } from '../transport/http-chat-transport'
import type { Resolvable } from '../transport/http-chat-transport'
import type {
  ChatInit,
  ChatOnFinishCallback,
  ChatOnErrorCallback,
  ChatOnToolCallCallback,
  ChatRequestOptions,
  ChatSendTrigger,
  ChatState,
  ChatStatus,
  ChatTransport,
} from '../types/chat'
import { isToolUIPart, type UIMessage, type UIMessagePart } from '../types/message'
import { generateId } from '../utils/id'
import { InjectedArrayState } from './injected-array-state'
import { UniversalChatState } from './chat-state'
import { lastAssistantMessageIsCompleteWithToolCalls } from './last-assistant-message-is-complete-with-tool-calls'
import {
  createDirectScheduler,
  createThrottleScheduler,
  type StreamScheduler,
} from '../scheduler'

/** 请求时注入的 instructions 消息 id，不写入会话数组 */
const INSTRUCTIONS_ID = '__instructions'

export type ChatTool = {
  description: string
  /** JSON Schema，作为 OpenAI function.parameters */
  parameters: Record<string, unknown>
  execute?: (opts: {
    input: unknown
    toolCall: { toolCallId: string; toolName: string; input: unknown }
  }) => unknown
}

export interface ChatOptions<UI_MESSAGE extends UIMessage = UIMessage>
  extends ChatInit<UI_MESSAGE> {
  /** chat/completions 端点 */
  api: string
  headers?: Resolvable<Record<string, string> | Headers>
  body?: Resolvable<object>
  fetch?: typeof globalThis.fetch
  adapter?: ChatAdapter<UI_MESSAGE>
  onStatusChange?: (status: ChatStatus) => void
  /**
   * 注入（响应式）数组：Chat 直接在其上 push / 单条赋值实现增量更新，
   * keyed 渲染（message.id 作 key）下只有活动消息组件重渲染。
   * 提供时内部走 InjectedArrayState，绝不创建独立数组副本。
   */
  messages?: UI_MESSAGE[]
  initialMessages?: UI_MESSAGE[]
  /** 底层状态容器，缺省时自动构建 */
  state?: ChatState<UI_MESSAGE>
  /**
   * 模型行为说明。每次请求前注入为临时 system 消息，不写入 messages / adapter.save。
   * 字符串事后可再赋值；回调在发请求时求值（切 tab / 切模式）。
   */
  instructions?: string | (() => string)
  /**
   * 客户端工具。有 execute 时自动执行并 addToolOutput，且默认自动续跑；
   * 同时编成 OpenAI function 清单并入请求 body.tools（自定义 transport 时需自行携带）。
   */
  tools?: Record<string, ChatTool>
  /** 消息流更新调度器（默认：50ms 节流） */
  streamScheduler?: StreamScheduler<UI_MESSAGE>
  /** 快捷设置调度器节流间隔（ms）。设为 0 则关闭节流 */
  throttle?: number
}

/**
 * 零依赖 Chat 类：状态机 + 流渲染 + 客户端工具回路 + 自动续跑。
 *
 * 与 AI SDK 的 Chat 语义对齐：
 * - 手写 onToolCall 时不要 await addToolOutput（会互等死锁），fire-and-forget 即可。
 * - 传入 tools.execute 时库内部处理执行与回填，调用方不必碰这条回路。
 * - abort 保留半截消息并把状态收敛回 ready；错误则置为 error 并保留消息。
 */
export class Chat<UI_MESSAGE extends UIMessage = UIMessage> {
  /** 会话唯一标识 */
  readonly id: string
  readonly ready: Promise<void>
  readonly adapter?: ChatAdapter<UI_MESSAGE>
  /** 当轮请求注入的说明，不写入 messages / adapter.save */
  instructions?: string | (() => string)
  /** 客户端工具；有 execute 时自动跑回路并编进 body.tools */
  tools?: Record<string, ChatTool>

  private state: ChatState<UI_MESSAGE>
  private readonly transport: ChatTransport<UI_MESSAGE>
  private readonly streamScheduler: StreamScheduler<UI_MESSAGE>
  private readonly onError?: ChatOnErrorCallback
  private readonly userOnToolCall?: ChatOnToolCallCallback
  private readonly onFinish?: ChatOnFinishCallback<UI_MESSAGE>
  private readonly sendAutomaticallyWhen?: ChatInit<UI_MESSAGE>['sendAutomaticallyWhen']
  private readonly initialMessages?: UI_MESSAGE[]

  private activeAbortController: AbortController | undefined
  private activeStreamState: UIMessageStreamState<UI_MESSAGE> | undefined
  private requestSequence = 0

  constructor(init: ChatOptions<UI_MESSAGE>) {
    const {
      onToolCall,
      adapter,
      api,
      headers,
      body,
      fetch,
      onStatusChange,
      messages: injectedMessages,
      initialMessages,
      state: customState,
      transport,
      instructions,
      tools,
      streamScheduler,
      throttle,
      ...rest
    } = init

    this.adapter = adapter
    this.instructions = instructions
    this.tools = tools
    this.initialMessages = initialMessages
    this.streamScheduler =
      streamScheduler ??
      (throttle !== undefined && throttle <= 0
        ? createDirectScheduler<UI_MESSAGE>()
        : createThrottleScheduler<UI_MESSAGE>({ waitMs: throttle ?? 50 }))
    this.state =
      customState ??
      (injectedMessages
        ? new InjectedArrayState<UI_MESSAGE>({
            messages: injectedMessages,
            onStatusChange,
            onMessagesChange: (messages) => adapter?.save?.(messages),
          })
        : new UniversalChatState<UI_MESSAGE>({
            onMessagesChange: (messages) => adapter?.save?.(messages),
            onStatusChange,
          }))
    this.transport =
      transport ??
      new DefaultChatTransport<UI_MESSAGE>({
        api,
        headers,
        body: () => this.mergeToolsIntoBody(body),
        fetch,
      })

    this.id = rest.id ?? generateId()
    this.onError = rest.onError
    this.userOnToolCall = onToolCall
    this.onFinish = rest.onFinish
    this.sendAutomaticallyWhen = rest.sendAutomaticallyWhen

    this.ready = this.hydrate()
  }

  private async hydrate() {
    const loaded = await this.adapter?.load?.()
    if (loaded?.length) {
      this.messages = loaded
    } else if (this.initialMessages?.length) {
      this.messages = this.initialMessages
    }
  }

  get messages(): UI_MESSAGE[] {
    return this.state.messages
  }

  set messages(messages: UI_MESSAGE[]) {
    this.state.messages = messages
  }

  get status(): ChatStatus {
    return this.state.status
  }

  get error(): Error | undefined {
    return this.state.error
  }

  private setStatus({ status, error }: { status: ChatStatus; error?: Error }) {
    this.state.error = error
    this.state.status = status
  }

  private get lastMessage(): UI_MESSAGE | undefined {
    return this.state.messages[this.state.messages.length - 1]
  }

  /** 中断当前请求：保留半截消息，状态收敛回 ready */
  stop() {
    this.activeAbortController?.abort()
  }

  /**
   * 发送一轮对话。
   * message 为空时仅触发一次请求（工具续跑 / 纯服务端会话场景）。
   */
  async sendMessage(
    message?:
      | { text: string; metadata?: unknown }
      | { id?: string; role?: 'user'; parts: UIMessagePart[] },
    options?: ChatRequestOptions,
  ): Promise<void> {
    if (this.status === 'submitted' || this.status === 'streaming') return

    let userMessageId: string | undefined
    if (message != null) {
      const userMessage = this.toUserMessage(message)
      this.state.pushMessage(userMessage)
      userMessageId = userMessage.id
    }

    await this.makeRequest({
      trigger: 'submit-message',
      messageId: userMessageId ?? this.lastMessage?.id,
      body: options?.body,
      headers: options?.headers,
    })
  }

  /**
   * 兼容旧版 universal-ai 的入口：与 sendMessage(undefined) 等价，
   * 但支持按 adapter.persistSession 决定是否复用会话状态。
   */
  async submit(opts: {
    body?: Record<string, unknown>
    headers?: Record<string, string> | Headers
    onMessage?: (type: 'pop' | 'push' | 'update', message: UI_MESSAGE) => void
  } = {}): Promise<void> {
    if (this.status === 'streaming') return

    const persistSession = this.adapter?.persistSession === true
    const onMessage = opts.onMessage
      ? (type: 'pop' | 'push' | 'update', message?: UI_MESSAGE) => {
          if (!message) return
          opts.onMessage!(type, message)
        }
      : undefined

    if (persistSession) {
      if (this.state instanceof UniversalChatState) this.state.setOnMessage(onMessage)
    } else {
      this.state = new UniversalChatState<UI_MESSAGE>({
        onMessage,
        onMessagesChange: (messages) => this.adapter?.save?.(messages),
      })
    }

    return this.sendMessage(undefined, {
      body: opts.body,
      headers: opts.headers,
    })
  }

  /**
   * 为客户端工具回填输出。与 AI SDK 一致：不要在 onToolCall 里 await 它。
   * 全部工具输出补齐后由 sendAutomaticallyWhen 决定是否自动续跑。
   */
  addToolOutput = async ({
    toolCallId,
    state: partState = 'output-available',
    output,
    errorText,
  }: {
    toolCallId: string
    state?: 'output-available' | 'output-error'
    output?: unknown
    errorText?: string
  }): Promise<void> => {
    const messages = this.state.messages
    const lastMessage = messages[messages.length - 1]
    if (!lastMessage) return

    const updatePart = (part: UIMessagePart): UIMessagePart => {
      if (isToolUIPart(part) && part.toolCallId === toolCallId) {
        return { ...part, state: partState, output, errorText } as UIMessagePart
      }
      return part
    }

    this.state.replaceMessage(messages.length - 1, {
      ...lastMessage,
      parts: lastMessage.parts.map(updatePart),
    })

    // 同步更新流处理器的工作副本：后续 chunk 的渲染通知以它为准，
    // 否则输出状态会被下一个 chunk 的快照覆盖回 input-available（对齐 AI SDK activeResponse 语义）
    const active = this.activeStreamState
    if (active) {
      active.message = { ...active.message, parts: active.message.parts.map(updatePart) }
    }

    if (this.status !== 'streaming' && this.status !== 'submitted') {
      // 不 await：避免与流处理互等死锁
      void this.maybeAutoSubmit()
    }
  }

  private async maybeAutoSubmit() {
    if (await this.shouldSendAutomatically()) {
      await this.makeRequest({
        trigger: 'submit-message',
        messageId: this.lastMessage?.id,
      })
    }
  }

  private async shouldSendAutomatically(): Promise<boolean> {
    const fn =
      this.sendAutomaticallyWhen ??
      (this.hasExecutableTools() ? lastAssistantMessageIsCompleteWithToolCalls : undefined)
    if (!fn) return false
    const result = fn({ messages: this.state.messages })
    if (result && typeof result === 'object' && 'then' in result) {
      return await result
    }
    return result as boolean
  }

  private toUserMessage(
    message: { text: string; metadata?: unknown } | { id?: string; role?: 'user'; parts: UIMessagePart[] },
  ): UI_MESSAGE {
    if ('text' in message) {
      return {
        id: generateId(),
        role: 'user',
        parts: [{ type: 'text', text: message.text }],
      } as unknown as UI_MESSAGE
    }
    return {
      id: message.id ?? generateId(),
      role: message.role ?? 'user',
      parts: message.parts,
    } as unknown as UI_MESSAGE
  }

  private async makeRequest({
    trigger,
    messageId,
    body,
    headers,
  }: {
    trigger: ChatSendTrigger
    messageId?: string
    body?: Record<string, unknown>
    headers?: Record<string, string> | Headers
  }): Promise<void> {
    // 重入保护：自动续跑与手动发送并发时，只允许第一请求生效
    if (this.status === 'submitted' || this.status === 'streaming') return

    const requestId = ++this.requestSequence
    const isCurrentRequest = () => requestId === this.requestSequence

    const abortController = new AbortController()
    this.activeAbortController = abortController

    // 对齐 AI SDK：上一条已是 assistant（工具续跑）时复用同一条消息追加 step，
    // 不要再 push 一条新 assistant——否则历史变成多条同 id 的 assistant，
    // 模型会把已完成的工具调用当成没发生过。
    const last = this.lastMessage
    const reuseAssistant = last?.role === 'assistant'
    const streamState: UIMessageStreamState<UI_MESSAGE> = {
      message: reuseAssistant
        ? ({ ...last, parts: last.parts.map((part) => ({ ...part })) } as UI_MESSAGE)
        : ({ id: generateId(), role: 'assistant', parts: [] } as unknown as UI_MESSAGE),
    }
    this.activeStreamState = streamState
    this.setStatus({ status: 'submitted' })
    // 快照请求消息：续跑时包含当前 assistant（已带 tool output）；首轮不含占位 assistant
    const requestMessages = [...this.state.messages]
    const prepared = this.adapter?.prepareMessages
      ? this.adapter.prepareMessages(requestMessages, { trigger, messageId })
      : requestMessages
    const outboundMessages = this.applyInstructions(prepared)
    if (!reuseAssistant) this.state.pushMessage(streamState.message)
    const messageIndex = this.state.messages.length - 1
    this.streamScheduler.reset?.()

    const commit = (msg: UI_MESSAGE) => this.state.replaceMessage(messageIndex, msg)
    const buildLatestSnapshot = (): UI_MESSAGE =>
      ({
        ...streamState.message,
        parts: streamState.message.parts.map((part) => ({ ...part })),
      } as UI_MESSAGE)

    let isError = false
    let isAbort = false

    try {
      const chunkStream = await this.transport.sendMessages({
        id: this.id,
        messages: outboundMessages,
        trigger,
        messageId,
        body,
        headers,
        abortSignal: abortController.signal,
      })

      this.setStatus({ status: 'streaming' })

      const processed = chunkStream.pipeThrough(
        processUIMessageStream<UI_MESSAGE>({
          state: streamState,
          onToolCall: ({ toolCall }) => this.handleToolCall({ toolCall }),
        }),
      )

      for await (const _chunk of processed) {
        this.streamScheduler.push(buildLatestSnapshot(), commit)
      }

      if (isCurrentRequest()) this.setStatus({ status: 'ready' })
    } catch (err) {
      if (isAbort || (err as { name?: string })?.name === 'AbortError') {
        isAbort = true
        if (isCurrentRequest()) this.setStatus({ status: 'ready' })
      } else {
        isError = true
        if (this.onError && err instanceof Error) this.onError(err)
        if (isCurrentRequest()) this.setStatus({ status: 'error', error: err as Error })
      }
    } finally {
      // 流中断时 processor 的 flush 不保证执行，这里统一收敛悬挂状态
      for (const part of streamState.message.parts) {
        if (part.type === 'text' && part.state === 'streaming') part.state = 'done'
      }
      this.streamScheduler.flush(buildLatestSnapshot(), commit)
      try {
        this.onFinish?.({
          message: streamState.message,
          messages: this.state.messages,
          isAbort,
          isError,
          finishReason: streamState.finishReason,
        })
      } finally {
        if (this.activeAbortController === abortController) {
          this.activeAbortController = undefined
        }
        if (this.activeStreamState === streamState) {
          this.activeStreamState = undefined
        }
      }
    }

    if (!isError && !isAbort && (await this.shouldSendAutomatically())) {
      await this.makeRequest({
        trigger: 'submit-message',
        messageId: this.lastMessage?.id,
        body,
        headers,
      })
    }
  }

  private hasExecutableTools() {
    const tools = this.tools
    if (!tools) return false
    for (const name in tools) {
      if (tools[name]?.execute) return true
    }
    return false
  }

  private applyInstructions(messages: UI_MESSAGE[]): UI_MESSAGE[] {
    const rest = messages.filter((m) => m.id !== INSTRUCTIONS_ID)
    const raw =
      typeof this.instructions === 'function' ? this.instructions() : this.instructions
    const text = raw?.trim()
    if (!text) return rest
    const system = {
      id: INSTRUCTIONS_ID,
      role: 'system' as const,
      parts: [{ type: 'text' as const, text }],
    } as UI_MESSAGE
    return [system, ...rest]
  }

  private toOpenAITools() {
    const tools = this.tools
    if (!tools) return undefined
    const names = Object.keys(tools)
    if (!names.length) return undefined
    return names.map((name) => ({
      type: 'function' as const,
      function: {
        name,
        description: tools[name].description,
        parameters: tools[name].parameters,
      },
    }))
  }

  private async mergeToolsIntoBody(userBody?: Resolvable<object>) {
    const resolved = ((await resolveResolvable(userBody)) ?? {}) as Record<string, unknown>
    const tools = this.toOpenAITools()
    return tools ? { ...resolved, tools } : resolved
  }

  private handleToolCall: ChatOnToolCallCallback = async ({ toolCall }) => {
    if (!toolCall.toolName || !toolCall.toolCallId) return

    const registered = this.tools?.[toolCall.toolName]
    if (registered?.execute) {
      try {
        const result = await registered.execute({
          input: toolCall.input,
          toolCall,
        })
        void this.addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: result ?? { ok: true },
        }).catch((error) => this.reportToolOutputError(error))
      } catch (err) {
        void this.addToolOutput({
          toolCallId: toolCall.toolCallId,
          state: 'output-error',
          errorText: err instanceof Error ? err.message : String(err),
        }).catch((error) => this.reportToolOutputError(error))
      }
      return
    }

    if (this.tools && Object.keys(this.tools).length && !registered) {
      void this.addToolOutput({
        toolCallId: toolCall.toolCallId,
        state: 'output-error',
        errorText: `未注册的工具：${toolCall.toolName}`,
      }).catch((error) => this.reportToolOutputError(error))
      return
    }

    await this.userOnToolCall?.({ toolCall })
  }

  private reportToolOutputError(error: unknown) {
    if (this.onError && error instanceof Error) this.onError(error)
  }
}

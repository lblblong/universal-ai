import type { ChatAdapter } from '../adapter'
import { processUIMessageStream, type UIMessageStreamState } from '../stream/process-ui-message-stream'
import { DefaultChatTransport } from '../transport/http-chat-transport'
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
   * hydrate 原位填充绝不更换引用。组件用 message.id 作 key 渲染即可只刷新活动消息。
   */
  messages?: UI_MESSAGE[]
  /** 初始消息种子（未注入数组时作为初始历史；注入时原位填充） */
  initialMessages?: UI_MESSAGE[]
  /** 自定义状态实现；缺省用 UniversalChatState（onMessagesChange → adapter.save） */
  state?: ChatState<UI_MESSAGE>
  /** 自定义传输；缺省用 DefaultChatTransport */
  transport?: ChatTransport<UI_MESSAGE>
}

/**
 * 零依赖 Chat 类：状态机 + 流渲染 + 客户端工具回路 + 自动续跑。
 *
 * 与 AI SDK 的 Chat 语义对齐：
 * - onToolCall 在流处理中被 await；回调里不要 await addToolOutput（会互等死锁），
 *   fire-and-forget 调用即可。
 * - addToolOutput / 流结束后都会检查 sendAutomaticallyWhen，决定是否自动续跑。
 * - abort 保留半截消息并把状态收敛回 ready；错误则置为 error 并保留消息。
 */
export class Chat<UI_MESSAGE extends UIMessage = UIMessage> {
  readonly id: string
  readonly ready: Promise<void>
  readonly adapter?: ChatAdapter<UI_MESSAGE>

  private state: ChatState<UI_MESSAGE>
  private readonly transport: ChatTransport<UI_MESSAGE>
  private readonly onError?: ChatOnErrorCallback
  private readonly onToolCall?: ChatOnToolCallCallback
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
      ...rest
    } = init

    this.adapter = adapter
    this.initialMessages = initialMessages
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
        body,
        fetch,
      })

    this.id = rest.id ?? generateId()
    this.onError = rest.onError
    this.onToolCall = onToolCall
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

    if (
      this.status !== 'streaming' &&
      this.status !== 'submitted' &&
      this.sendAutomaticallyWhen
    ) {
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
    if (!this.sendAutomaticallyWhen) return false
    const result = this.sendAutomaticallyWhen({ messages: this.state.messages })
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
    const outboundMessages = this.adapter?.prepareMessages
      ? this.adapter.prepareMessages(requestMessages, { trigger, messageId })
      : requestMessages
    if (!reuseAssistant) this.state.pushMessage(streamState.message)
    const messageIndex = this.state.messages.length - 1
    // 交付快照：每次通知交付一份新对象（消息 + parts + part 逐层浅拷贝），
    // 库在交付后不再改动它——消费者拿到的引用是稳定的不可变快照
    const notifyUpdate = () =>
      this.state.replaceMessage(messageIndex, {
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
          onToolCall: this.onToolCall
            ? ({ toolCall }) => this.onToolCall!({ toolCall })
            : undefined,
        }),
      )

      for await (const _chunk of processed) {
        notifyUpdate()
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
      notifyUpdate()
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
}

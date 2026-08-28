import {
  AbstractChat,
  ChatInit as BaseChatInit,
  ChatState,
  ChatStatus,
  DefaultChatTransport,
  UIMessage,
} from 'ai'
import { ChatAdapter } from './adapter'

export class UniversalChatState<UI_MESSAGE extends UIMessage>
  implements ChatState<UI_MESSAGE>
{
  private _messages: UI_MESSAGE[] = []
  private statusRef: ChatStatus = 'ready'
  private _error?: Error = undefined
  private _onMessage: (
    type: 'push' | 'pop' | 'update',
    message?: UI_MESSAGE,
  ) => void
  private _onMessagesChange?: (messages: UI_MESSAGE[]) => void
  private _onStatusChange?: (status: ChatStatus) => void

  constructor(opts?: {
    onMessage?: (
      type: 'push' | 'pop' | 'update',
      message?: UI_MESSAGE,
    ) => void
    onMessagesChange?: (messages: UI_MESSAGE[]) => void
    onStatusChange?: (status: ChatStatus) => void
  }) {
    this._onMessage = opts?.onMessage || (() => {})
    this._onMessagesChange = opts?.onMessagesChange
    this._onStatusChange = opts?.onStatusChange
  }

  setOnMessage(
    onMessage?: (
      type: 'push' | 'pop' | 'update',
      message?: UI_MESSAGE,
    ) => void,
  ) {
    this._onMessage = onMessage || (() => {})
  }

  get messages(): UI_MESSAGE[] {
    return this._messages
  }

  set messages(messages: UI_MESSAGE[]) {
    this._messages = messages
    this._onMessagesChange?.(this._messages)
  }

  get status(): ChatStatus {
    return this.statusRef
  }

  set status(status: ChatStatus) {
    this.statusRef = status
    this._onStatusChange?.(status)
  }

  get error(): Error | undefined {
    return this._error
  }

  set error(error: Error | undefined) {
    this._error = error
  }

  pushMessage = (message: UI_MESSAGE) => {
    this.messages = this.messages.concat(message)
    this._onMessage('push', message)
  }

  popMessage = () => {
    this.messages = this.messages.slice(0, -1)
    this._onMessage('pop')
  }

  replaceMessage = (index: number, message: UI_MESSAGE) => {
    // clone：Vue 深层响应式在更新 tool invocation parts 时会异常
    this.messages[index] = { ...message }
    this._onMessagesChange?.(this._messages)
    this._onMessage('update', message)
  }

  snapshot = <T>(value: T): T => value
}

export type ChatOptions<UI_MESSAGE extends UIMessage> = BaseChatInit<UI_MESSAGE> & {
  api: string
  headers?: Record<string, string> | Headers | (() => Record<string, string> | Headers | Promise<Record<string, string> | Headers>)
  body?: Record<string, any> | (() => Record<string, any>)
  fetch?: typeof globalThis.fetch
  adapter?: ChatAdapter<UI_MESSAGE>
  onStatusChange?: (status: ChatStatus) => void
}

export class Chat<
  UI_MESSAGE extends UIMessage,
> extends AbstractChat<UI_MESSAGE> {
  readonly adapter?: ChatAdapter<UI_MESSAGE>
  readonly ready: Promise<void>
  private readonly chatState: UniversalChatState<UI_MESSAGE>

  constructor(init: ChatOptions<UI_MESSAGE>) {
    const {
      onToolCall,
      adapter,
      api,
      headers,
      body,
      fetch,
      onStatusChange,
      ...rest
    } = init
    const state = new UniversalChatState<UI_MESSAGE>({
      onMessagesChange: (messages) => adapter?.save?.(messages),
      onStatusChange,
    })

    super({
      ...rest,
      onToolCall,
      state,
      transport: new DefaultChatTransport({
        api,
        headers,
        body,
        fetch,
        prepareSendMessagesRequest: adapter?.prepareMessages
          ? ({
              id,
              messages,
              trigger,
              messageId,
              body: requestBody,
              headers: requestHeaders,
              credentials,
              api: requestApi,
            }) => ({
              body: {
                id,
                ...requestBody,
                messages: adapter.prepareMessages!(messages, {
                  trigger,
                  messageId,
                }),
                trigger,
                messageId,
              },
              headers: requestHeaders,
              credentials,
              api: requestApi,
            })
          : undefined,
      }),
    })

    this.adapter = adapter
    this.chatState = state
    this.ready = this.hydrate()
  }

  private async hydrate() {
    const loaded = await this.adapter?.load?.()
    if (loaded?.length) this.messages = loaded
  }

  async submit(opts: {
    body?: Record<string, any>
    headers?: Record<string, string> | Headers
    onMessage?: (type: 'pop' | 'push' | 'update', message: UI_MESSAGE) => void
  }) {
    if (this.status === 'streaming') return

    const persistSession = this.adapter?.persistSession === true
    const onMessage = (type: 'pop' | 'push' | 'update', message?: UI_MESSAGE) => {
      if (!message) return
      opts.onMessage?.(type, message)
    }

    if (persistSession) {
      this.chatState.setOnMessage(onMessage)
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
}

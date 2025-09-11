import {
  AbstractChat,
  ChatInit as BaseChatInit,
  ChatState,
  ChatStatus,
  DefaultChatTransport,
  UIMessage,
} from 'ai'

export class UniversalChatState<UI_MESSAGE extends UIMessage>
  implements ChatState<UI_MESSAGE>
{
  private _messages: UI_MESSAGE[] = []
  private statusRef: ChatStatus = 'ready'
  private _error?: Error = undefined
  private readonly _onMessage: (
    type: 'push' | 'pop' | 'update',
    message?: UI_MESSAGE
  ) => void

  constructor(
    onMessage?: (type: 'push' | 'pop' | 'update', message?: UI_MESSAGE) => void
  ) {
    this._onMessage = onMessage || (() => {})
  }

  get messages(): UI_MESSAGE[] {
    return this._messages
  }

  set messages(messages: UI_MESSAGE[]) {
    this._messages = messages
  }

  get status(): ChatStatus {
    return this.statusRef
  }

  set status(status: ChatStatus) {
    this.statusRef = status
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
    // message is cloned here because vue's deep reactivity shows unexpected behavior, particularly when updating tool invocation parts
    this.messages[index] = { ...message }
    this._onMessage('update', message)
  }

  snapshot = <T>(value: T): T => value
}

export class Chat<
  UI_MESSAGE extends UIMessage
> extends AbstractChat<UI_MESSAGE> {
  constructor(
    init: BaseChatInit<UI_MESSAGE> & {
      api: string
      headers?: Record<string, string> | Headers
      body?: Record<string, any>
    }
  ) {
    super({
      ...init,
      state: new UniversalChatState(),
      transport: new DefaultChatTransport({
        api: init.api,
        headers: init.headers,
        body: init.body,
      }),
    })
  }

  async submit(opts: {
    body?: Record<string, any>
    headers?: Record<string, string> | Headers
    onMessage?: (type: 'pop' | 'push' | 'update', message: UI_MESSAGE) => void
  }) {
    if (this.status === 'streaming') return
    this.state = new UniversalChatState((type, message) => {
      if (!message) return
      opts.onMessage?.(type, message)
    })

    return this.sendMessage(undefined, {
      body: opts.body,
      headers: opts.headers,
    })
  }
}


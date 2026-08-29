import type { ChatState, ChatStatus } from '../types/chat'
import type { UIMessage } from '../types/message'

type MessageListener<UI_MESSAGE extends UIMessage> = (
  type: 'push' | 'pop' | 'update',
  message?: UI_MESSAGE,
) => void

/**
 * 框架无关的 Chat 状态实现：宿主（React/Vue/响应式 store）通过
 * onMessage / onMessagesChange / onStatusChange 钩子把状态接进自己的响应式系统。
 */
export class UniversalChatState<UI_MESSAGE extends UIMessage> implements ChatState<UI_MESSAGE> {
  private _messages: UI_MESSAGE[] = []
  private statusRef: ChatStatus = 'ready'
  private _error?: Error = undefined
  private _onMessage: MessageListener<UI_MESSAGE>
  private _onMessagesChange?: (messages: UI_MESSAGE[]) => void
  private _onStatusChange?: (status: ChatStatus) => void

  constructor(opts?: {
    onMessage?: MessageListener<UI_MESSAGE>
    onMessagesChange?: (messages: UI_MESSAGE[]) => void
    onStatusChange?: (status: ChatStatus) => void
  }) {
    this._onMessage = opts?.onMessage || (() => {})
    this._onMessagesChange = opts?.onMessagesChange
    this._onStatusChange = opts?.onStatusChange
  }

  setOnMessage(onMessage?: MessageListener<UI_MESSAGE>) {
    this._onMessage = (onMessage || (() => {})) as MessageListener<UI_MESSAGE>
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
    // 浅拷贝：保证深层框架（如 Vue 响应式）能感知部件数组内的变化
    this.messages[index] = { ...message }
    this._onMessagesChange?.(this._messages)
    this._onMessage('update', message)
  }

  snapshot = <T>(value: T): T => value
}

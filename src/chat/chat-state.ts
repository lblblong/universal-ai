import type { ChatState, ChatStatus } from '../types/chat'
import type { UIMessage } from '../types/message'
import { createBatchedNotifier } from '../utils/batch-notify'

type MessageListener<UI_MESSAGE extends UIMessage> = (
  type: 'push' | 'pop' | 'update',
  message?: UI_MESSAGE,
) => void

/**
 * 框架无关的 Chat 状态实现：宿主（React/Vue/响应式 store）通过
 * onMessage / onMessagesChange / onStatusChange 钩子把状态接进自己的响应式系统。
 *
 * 性能契约：Chat 每次通知都交付全新消息快照（消息 + parts 逐层拷贝），
 * 数组内非活动消息的引用保持稳定；onMessagesChange 按事件循环轮次合并（trailing 节流），
 * 消费端不应依赖它做逐 token 渲染（响应式绑定数组项即可）。
 */
export class UniversalChatState<UI_MESSAGE extends UIMessage> implements ChatState<UI_MESSAGE> {
  private _messages: UI_MESSAGE[] = []
  private statusRef: ChatStatus = 'ready'
  private _error?: Error = undefined
  private _onMessage: MessageListener<UI_MESSAGE>
  private _onMessagesChange?: () => void
  private _onStatusChange?: (status: ChatStatus) => void

  constructor(opts?: {
    onMessage?: MessageListener<UI_MESSAGE>
    onMessagesChange?: (messages: UI_MESSAGE[]) => void
    onStatusChange?: (status: ChatStatus) => void
  }) {
    this._onMessage = opts?.onMessage || (() => {})
    this._onMessagesChange = opts?.onMessagesChange
      ? createBatchedNotifier(() => opts.onMessagesChange!(this._messages))
      : undefined
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
    this._onMessagesChange?.()
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
    this._messages = this._messages.concat(message)
    this._onMessagesChange?.()
    this._onMessage('push', message)
  }

  popMessage = () => {
    this._messages = this._messages.slice(0, -1)
    this._onMessagesChange?.()
    this._onMessage('pop')
  }

  replaceMessage = (index: number, message: UI_MESSAGE) => {
    // message 已由 Chat 交付为快照（交付后不可变），这里只做单条赋值
    this._messages[index] = message
    this._onMessagesChange?.()
    this._onMessage('update', message)
  }

  snapshot = <T>(value: T): T => value
}

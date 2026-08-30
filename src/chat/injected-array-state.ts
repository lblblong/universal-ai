import type { ChatState, ChatStatus } from '../types/chat'
import type { UIMessage } from '../types/message'
import { createBatchedNotifier } from '../utils/batch-notify'

/**
 * 注入数组状态：把 Chat 的更新直通进消费者提供的（响应式）数组。
 *
 * 增量契约：
 * - 新消息 push（原位，长度变化被依赖追踪捕获）
 * - 流式更新单条赋值 messages[i] = snapshot（数组引用稳定，keyed 渲染只刷活动项）
 * - hydrate 用 splice 原位填充，绝不重赋值——保住注入的引用 / 响应式绑定
 */
export class InjectedArrayState<UI_MESSAGE extends UIMessage> implements ChatState<UI_MESSAGE> {
  private readonly array: UI_MESSAGE[]
  private statusRef: ChatStatus = 'ready'
  private errorRef?: Error = undefined
  private readonly onStatusChange?: (status: ChatStatus) => void
  private readonly notifyMessagesChanged?: () => void

  constructor(options: {
    messages: UI_MESSAGE[]
    onStatusChange?: (status: ChatStatus) => void
    onMessagesChange?: (messages: UI_MESSAGE[]) => void
  }) {
    this.array = options.messages
    this.onStatusChange = options.onStatusChange
    this.notifyMessagesChanged = options.onMessagesChange
      ? createBatchedNotifier(() => options.onMessagesChange!(this.array))
      : undefined
  }

  get messages(): UI_MESSAGE[] {
    return this.array
  }

  /** 原位填充，绝不更换数组引用（否则消费者的响应式绑定会被打断） */
  set messages(value: UI_MESSAGE[]) {
    this.array.splice(0, this.array.length, ...value)
    this.notifyMessagesChanged?.()
  }

  get status(): ChatStatus {
    return this.statusRef
  }

  set status(status: ChatStatus) {
    if (this.statusRef === status) return
    this.statusRef = status
    this.onStatusChange?.(status)
  }

  get error(): Error | undefined {
    return this.errorRef
  }

  set error(error: Error | undefined) {
    this.errorRef = error
  }

  pushMessage = (message: UI_MESSAGE) => {
    this.array.push(message)
    this.notifyMessagesChanged?.()
  }

  popMessage = () => {
    this.array.pop()
    this.notifyMessagesChanged?.()
  }

  replaceMessage = (index: number, message: UI_MESSAGE) => {
    this.array[index] = message
    this.notifyMessagesChanged?.()
  }

  snapshot = <T>(value: T): T => value
}

/**
 * 快照通知的批量合并（trailing 节流）：
 * 同一次事件循环轮次内的多次变更只触发一次回调。
 *
 * 注意必须用宏任务（setTimeout）而不是 queueMicrotask：流式读取的每个 chunk
 * 之间都隔着 await（微任务边界），微任务合并会被 FIFO 冲掉，起不到合并作用；
 * 宏任务合并则把同一轮内的全部变更（无论同步爆发还是缓冲流一次性到达）
 * 合并成一次通知，网络分包场景下也天然对应"每包至多一次"。
 *
 * 用于 onMessagesChange（快照通知）——渲染路径应走响应式数组绑定或注入，
 * 此回调只服务持久化 / 特殊同步场景。
 */
export function createBatchedNotifier(notify: () => void): () => void {
  let scheduled = false
  return () => {
    if (scheduled) return
    scheduled = true
    setTimeout(() => {
      scheduled = false
      notify()
    }, 0)
  }
}

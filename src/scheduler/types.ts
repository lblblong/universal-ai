import type { UIMessage } from '../types/message'

/**
 * 流式调度器契约：
 * 负责控制流式更新（chunks）写入 UI 状态（响应式数组 / 视图层）的步调与节奏。
 */
export interface StreamScheduler<UI_MESSAGE extends UIMessage = UIMessage> {
  /**
   * 接收到新流式状态时调用。
   * @param message 最新的完整消息快照（数据源真实状态）
   * @param commit 将经过调度/插值后的消息快照写入 UI 状态
   */
  push: (message: UI_MESSAGE, commit: (msg: UI_MESSAGE) => void) => void

  /**
   * 流结束（finish）、异常（error）或用户中断（abort）时调用。
   * 必须立刻清空缓冲区，强制提交最终完整内容并清理所有内部定时器/帧循环。
   * @param message 最终完整的消息快照
   * @param commit 立即提交最终快照
   */
  flush: (message: UI_MESSAGE, commit: (msg: UI_MESSAGE) => void) => void

  /**
   * 重置调度器内部状态（可选），每次新请求开始时被调用。
   */
  reset?: () => void
}

export interface ThrottleSchedulerOptions {
  /**
   * 节流等待毫秒数（默认 50ms，约 20 FPS）。
   * 既能平抑高频重渲染，又保持流畅的视觉更新。
   */
  waitMs?: number
  /**
   * 首个 chunk 是否立即派发（默认 true）。
   * 保证首字响应零延迟。
   */
  leading?: boolean
}

export interface SmoothSchedulerOptions {
  /**
   * 目标字符输出速率（每秒字符数，默认 40 字符/秒）。
   */
  cps?: number
  /**
   * 帧刷新周期毫秒数（默认 16ms，约 60 FPS）。
   */
  frameMs?: number
  /**
   * 缓冲区积压字符阈值（默认 80 字符）。
   * 当实际到达字符远超出已展示字符时，自动加速追赶，防止生成完毕后长时间等待。
   */
  catchUpThreshold?: number
  /**
   * 最大加速追赶倍率（默认 4 倍）。
   */
  maxCatchUpFactor?: number
}

export interface LineSchedulerOptions {
  /**
   * 超长单行未遇到换行符时的最大缓冲字符数（默认 120 字符）。
   * 防止超长单行长时间不更新界面。
   */
  maxLineChars?: number
  /**
   * 行间节流间隔毫秒数（默认 0，即产生完整行后立即提交）。
   */
  throttleMs?: number
}


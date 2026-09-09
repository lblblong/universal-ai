import { describe, expect, it, vi } from 'vitest'
import {
  createDirectScheduler,
  createLineScheduler,
  createSmoothScheduler,
  createThrottleScheduler,
} from '../../src/scheduler'
import type { UIMessage } from '../../src/types/message'

const makeMessage = (text: string, extraParts: any[] = []): UIMessage => ({
  id: 'msg-1',
  role: 'assistant',
  parts: [{ type: 'text', text }, ...extraParts],
})

describe('StreamScheduler', () => {
  describe('createThrottleScheduler', () => {
    it('默认 leading 立即提交首个更新，后续更新在窗口内节流并由 flush 收尾', async () => {
      vi.useFakeTimers()
      const scheduler = createThrottleScheduler<UIMessage>({ waitMs: 50, leading: true })
      const commits: UIMessage[] = []
      const commit = (m: UIMessage) => commits.push(m)

      scheduler.push(makeMessage('H'), commit)
      expect(commits).toHaveLength(1)
      expect((commits[0].parts[0] as any).text).toBe('H')

      scheduler.push(makeMessage('He'), commit)
      scheduler.push(makeMessage('Hel'), commit)
      scheduler.push(makeMessage('Hell'), commit)
      // 节流期内不立即提交
      expect(commits).toHaveLength(1)

      // 时间步进 50ms
      vi.advanceTimersByTime(50)
      expect(commits).toHaveLength(2)
      expect((commits[1].parts[0] as any).text).toBe('Hell')

      // flush 立即交付最终快照
      scheduler.push(makeMessage('Hello!'), commit)
      scheduler.flush(makeMessage('Hello! World'), commit)
      expect(commits.at(-1)?.parts[0]).toMatchObject({ text: 'Hello! World' })

      vi.useRealTimers()
    })
  })

  describe('createSmoothScheduler', () => {
    it('按字符速率平滑插值，并在 flush 时瞬间交付完整内容', async () => {
      vi.useFakeTimers()
      const scheduler = createSmoothScheduler<UIMessage>({ cps: 50 })
      const commits: UIMessage[] = []
      const commit = (m: UIMessage) => commits.push(m)

      const fullText = '这是一段用来测试平滑打字机效果的长文本内容。'
      scheduler.push(makeMessage(fullText), commit)

      // 首字即刻呈现
      expect(commits.length).toBeGreaterThanOrEqual(1)
      expect(((commits[0].parts[0] as any).text.length)).toBeLessThanOrEqual(5)

      // 步进若干毫秒，字符数逐渐增加但还没达到完整长度
      vi.advanceTimersByTime(100)
      const midText = (commits.at(-1)?.parts[0] as any).text
      expect(midText.length).toBeGreaterThan(0)
      expect(midText.length).toBeLessThan(fullText.length)

      // flush 时瞬间拉满
      scheduler.flush(makeMessage(fullText), commit)
      expect((commits.at(-1)?.parts[0] as any).text).toBe(fullText)

      vi.useRealTimers()
    })

    it('非文本类 part（如 tool-call）不被截断并完整保留', async () => {
      const scheduler = createSmoothScheduler<UIMessage>({ cps: 40 })
      const commits: UIMessage[] = []
      const commit = (m: UIMessage) => commits.push(m)

      const toolPart = {
        type: 'dynamic-tool',
        toolCallId: 'call_1',
        toolName: 'apply_form',
        input: { key: 'val' },
        state: 'input-available',
      }
      scheduler.push(makeMessage('正在配置表单...', [toolPart]), commit)

      const firstCommit = commits[0]
      expect(firstCommit.parts).toHaveLength(2)
      expect(firstCommit.parts[1]).toEqual(toolPart)

      scheduler.flush(makeMessage('配置完成！', [toolPart]), commit)
      expect(commits.at(-1)?.parts[1]).toEqual(toolPart)
    })
  })

  describe('createLineScheduler', () => {
    it('按完整换行符提交，遇到 \\n 前不提交未闭合行，flush 时提交完整内容', async () => {
      const scheduler = createLineScheduler<UIMessage>()
      const commits: UIMessage[] = []
      const commit = (m: UIMessage) => commits.push(m)

      // 还没换行
      scheduler.push(makeMessage('Line 1 without newline'), commit)
      expect((commits[0].parts[0] as any).text).toBe('L') // 初始占位首字符

      // 输出了换行符
      scheduler.push(makeMessage('Line 1\nLine 2 half'), commit)
      expect((commits[1].parts[0] as any).text).toBe('Line 1\n')

      // 第二行也换行
      scheduler.push(makeMessage('Line 1\nLine 2\nLine 3'), commit)
      expect((commits[2].parts[0] as any).text).toBe('Line 1\nLine 2\n')

      // flush 提交全部
      scheduler.flush(makeMessage('Line 1\nLine 2\nLine 3 end'), commit)
      expect((commits.at(-1)?.parts[0] as any).text).toBe('Line 1\nLine 2\nLine 3 end')
    })
  })

  describe('createDirectScheduler', () => {
    it('直通模式：每次 push 和 flush 均即时提交', () => {
      const scheduler = createDirectScheduler<UIMessage>()
      const commits: UIMessage[] = []
      const commit = (m: UIMessage) => commits.push(m)

      scheduler.push(makeMessage('A'), commit)
      scheduler.push(makeMessage('AB'), commit)
      scheduler.flush(makeMessage('ABC'), commit)

      expect(commits).toHaveLength(3)
      expect((commits[2].parts[0] as any).text).toBe('ABC')
    })
  })
})


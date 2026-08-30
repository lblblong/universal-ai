import { describe, expect, it, vi } from 'vitest'
import { Chat } from '../../src/chat/chat'
import { lastAssistantMessageIsCompleteWithToolCalls } from '../../src/chat/last-assistant-message-is-complete-with-tool-calls'
import type { UIMessageChunk } from '../../src/types/chunk'
import type { UIMessage } from '../../src/types/message'
import { mockFetch, sseResponse, streamingSseResponse, textStreamChunks } from '../helpers/sse'

const AUTO_SUBMIT = lastAssistantMessageIsCompleteWithToolCalls

const waitFor = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForCondition(fn: () => boolean, timeout = 3000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitForCondition timeout')
    await waitFor(5)
  }
}

const assistantText = (m: UIMessage | undefined) =>
  (m?.parts.filter((p) => p.type === 'text')[0] as any)?.text ?? ''

/** 10 个独立 delta 的流式响应（每 15ms 一个），用于观察流式中间态 */
function slowDeltaResponse(): Response {
  const chunks: UIMessageChunk[] = [
    { type: 'start', messageId: 'a1' },
    { type: 'start-step' },
    { type: 'text-start', id: 't1' },
    ...Array.from({ length: 10 }, (_, i) => ({ type: 'text-delta', id: 't1', delta: String(i) })),
    { type: 'text-end', id: 't1' },
    { type: 'finish-step' },
    { type: 'finish', finishReason: 'stop' },
  ]
  return streamingSseResponse(chunks, undefined, 15)
}

describe('注入数组契约（messages 选项）', () => {
  it('流式期间数组引用稳定，更新表现为单条赋值', async () => {
    const { fetch } = mockFetch([sseResponse(textStreamChunks('流式回复'))])
    const bound: UIMessage[] = []
    const chat = new Chat({ api: '/api/chat', fetch, messages: bound })

    expect(chat.messages).toBe(bound)
    await chat.sendMessage({ text: '你好' })

    expect(bound).toHaveLength(2)
    expect(bound[1].role).toBe('assistant')
    expect(assistantText(bound[1])).toBe('流式回复')
    // 引用自始至终是注入的那个数组
    expect(chat.messages).toBe(bound)
  })

  it('非活动消息引用永不变化（keyed 渲染稳定的前提）', async () => {
    const { fetch } = mockFetch([
      sseResponse(textStreamChunks('第一轮回复')),
      sseResponse(textStreamChunks('第二轮回复')),
    ])
    const bound: UIMessage[] = []
    const chat = new Chat({ api: '/api/chat', fetch, messages: bound })

    await chat.sendMessage({ text: '第一问' })
    const userMessage = bound[0]
    const firstAssistant = bound[1]

    await chat.sendMessage({ text: '第二问' })

    // 历史消息对象引用保持不变，只有新消息是新增
    expect(bound[0]).toBe(userMessage)
    expect(bound[1]).toBe(firstAssistant)
    expect(bound).toHaveLength(4)
  })

  it('交付的消息是不可变快照：捕获后不再被流式更新改动', async () => {
    const fetchFn = (async () => slowDeltaResponse()) as unknown as typeof globalThis.fetch
    const bound: UIMessage[] = []
    const chat = new Chat({ api: '/api/chat', fetch: fetchFn, messages: bound })

    const sending = chat.sendMessage({ text: 'hi' })
    await waitForCondition(() => assistantText(bound[1]).length >= 4)
    const midStream = bound[1]
    const midText = assistantText(midStream)
    expect(midText.length).toBeGreaterThanOrEqual(4)

    await sending

    // 捕获的快照停留在捕获时刻的内容，后续 token 不会写进它
    expect(assistantText(midStream)).toBe(midText)
    // 活动消息随流式推进被整体替换为新对象
    expect(bound[1]).not.toBe(midStream)
    expect(assistantText(bound[1])).toBe('0123456789')
  })

  it('hydrate（adapter.load）原位填充，注入的数组引用不被打断', async () => {
    const history: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '旧问题' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '旧回答' }] },
    ]
    const adapter = { load: () => history }
    const { fetch } = mockFetch([sseResponse(textStreamChunks('新回答'))])
    const bound: UIMessage[] = []
    const chat = new Chat({ api: '/api/chat', fetch, messages: bound, adapter })

    await chat.ready
    expect(bound).toHaveLength(2)
    expect(bound[0].id).toBe('u1')
    // 引用仍是注入的数组
    expect(chat.messages).toBe(bound)

    await chat.sendMessage({ text: '新问题' })
    expect(bound).toHaveLength(4)
    expect(chat.messages).toBe(bound)
  })

  it('hydrate 前预填内容会被 load 结果原位替换，且引用不变', async () => {
    const history: UIMessage[] = [{ id: 'a0', role: 'assistant', parts: [{ type: 'text', text: '历史' }] }]
    const adapter = { load: () => history }
    const bound: UIMessage[] = [{ id: 'x', role: 'user', parts: [{ type: 'text', text: '预填' }] }]
    const { fetch } = mockFetch([sseResponse(textStreamChunks('ok'))])
    const chat = new Chat({ api: '/api/chat', fetch, messages: bound, adapter })
    await chat.ready
    expect(bound.map((m) => m.id)).toEqual(['a0'])
    expect(chat.messages).toBe(bound)
  })

  it('注入数组 + 工具回路：输出回填与自动续跑照常工作', async () => {
    const toolTurn: UIMessageChunk[] = [
      { type: 'start', messageId: 'a1' },
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'get_weather', input: { city: '北京' } },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'tool-calls' },
    ]
    const { fetch, requests } = mockFetch([sseResponse(toolTurn), sseResponse(textStreamChunks('北京35度'))])
    const bound: UIMessage[] = []
    const chat = new Chat({
      api: '/api/chat',
      fetch,
      messages: bound,
      sendAutomaticallyWhen: AUTO_SUBMIT,
      onToolCall: ({ toolCall }) => {
        void chat.addToolOutput({ toolCallId: toolCall.toolCallId, output: { temperature: 35 } })
      },
    })

    await chat.sendMessage({ text: '北京天气' })

    expect(requests).toHaveLength(2)
    expect(bound).toHaveLength(2)
    expect(bound[1].parts.some((p) => (p as any).state === 'output-available')).toBe(true)
    expect(assistantText(bound[1])).toBe('北京35度')
    expect(chat.messages).toBe(bound)
  })

  it('onStatusChange 在注入模式下照常触发', async () => {
    const { fetch } = mockFetch([sseResponse(textStreamChunks('ok'))])
    const statuses: string[] = []
    const bound: UIMessage[] = []
    const chat = new Chat({
      api: '/api/chat',
      fetch,
      messages: bound,
      onStatusChange: (s) => statuses.push(s),
    })
    await chat.sendMessage({ text: 'hi' })
    expect(statuses).toEqual(['submitted', 'streaming', 'ready'])
  })
})

describe('快照通知批量合并（onMessagesChange / adapter.save）', () => {
  it('10 个 delta 一次性到达：save 只按轮次合并触发，且最终快照完整', async () => {
    const save = vi.fn()
    const { fetch } = mockFetch([
      sseResponse([
        { type: 'start', messageId: 'a1' },
        { type: 'start-step' },
        { type: 'text-start', id: 't1' },
        ...Array.from({ length: 10 }, (_, i) => ({ type: 'text-delta', id: 't1', delta: String(i) })),
        { type: 'text-end', id: 't1' },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'stop' },
      ]),
    ])
    const chat = new Chat({ api: '/api/chat', fetch, adapter: { save } })
    await chat.sendMessage({ text: 'hi' })
    await waitFor(20) // 等 trailing flush

    // 12+ 次变更被合并成个位数次通知
    expect(save.mock.calls.length).toBeGreaterThanOrEqual(1)
    expect(save.mock.calls.length).toBeLessThanOrEqual(4)
    // 最后一次是完整快照
    const last = save.mock.calls[save.mock.calls.length - 1][0] as UIMessage[]
    expect(last).toHaveLength(2)
    expect(assistantText(last[1])).toBe('0123456789')
  })

  it('慢速流（跨轮次到达）：逐包通知，最终快照完整', async () => {
    const save = vi.fn()
    const fetchFn = (async () => slowDeltaResponse()) as unknown as typeof globalThis.fetch
    const chat = new Chat({ api: '/api/chat', fetch: fetchFn, adapter: { save } })
    await chat.sendMessage({ text: 'hi' })
    await waitFor(20)

    // 跨轮次的分包流按"每轮至多一次"逐包通知（渲染路径是注入数组，不走回调）
    expect(save.mock.calls.length).toBeGreaterThanOrEqual(1)
    const last = save.mock.calls[save.mock.calls.length - 1][0] as UIMessage[]
    expect(assistantText(last[1])).toBe('0123456789')
  })
})

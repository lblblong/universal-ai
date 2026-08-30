import { describe, expect, it, vi } from 'vitest'
import { Chat } from '../../src/chat/chat'
import { lastAssistantMessageIsCompleteWithToolCalls } from '../../src/chat/last-assistant-message-is-complete-with-tool-calls'
import { createLocalHistoryAdapter, createServerHistoryAdapter, type ChatAdapter } from '../../src/adapter'
import type { UIMessageChunk } from '../../src/types/chunk'
import type { UIMessage } from '../../src/types/message'
import { mockFetch, sseResponse, streamingSseResponse, textStreamChunks } from '../helpers/sse'

const AUTO_SUBMIT = lastAssistantMessageIsCompleteWithToolCalls

const waitFor = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitForCondition(fn: () => boolean, timeout = 2000) {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeout) throw new Error('waitForCondition timeout')
    await waitFor(10)
  }
}

describe('Chat 基础对话', () => {
  it('发送文本 → 流式渲染 → 状态机 ready→submitted→streaming→ready', async () => {
    const { fetch, requests } = mockFetch([sseResponse(textStreamChunks('你好，我是助手'))])
    const statuses: string[] = []
    const chat = new Chat({
      api: '/api/chat',
      fetch,
      onStatusChange: (s) => statuses.push(s),
    })

    await chat.sendMessage({ text: '你好' })

    expect(statuses).toEqual(['submitted', 'streaming', 'ready'])
    expect(chat.messages).toHaveLength(2)
    expect(chat.messages[0]).toMatchObject({ role: 'user', parts: [{ type: 'text', text: '你好' }] })
    expect(chat.messages[1].role).toBe('assistant')
    expect(chat.messages[1].parts.some((p) => p.type === 'text' && (p as any).text === '你好，我是助手')).toBe(true)
    expect(chat.status).toBe('ready')

    // 请求体对齐 UI message 协议
    const body = requests[0].body
    expect(body.trigger).toBe('submit-message')
    expect(body.messages).toHaveLength(1)
    expect(body.messages[0].role).toBe('user')
    expect(chat.id).toBe(body.id)
  })

  it('onFinish 收到完整消息与收尾原因', async () => {
    const { fetch } = mockFetch([sseResponse(textStreamChunks('done'))])
    const onFinish = vi.fn()
    const chat = new Chat({ api: '/api/chat', fetch, onFinish })
    await chat.sendMessage({ text: 'hi' })
    expect(onFinish).toHaveBeenCalledTimes(1)
    const arg = onFinish.mock.calls[0][0]
    expect(arg.message.role).toBe('assistant')
    expect(arg.messages).toHaveLength(2)
    expect(arg.isAbort).toBe(false)
    expect(arg.isError).toBe(false)
  })

  it('流式期间重复 sendMessage 被忽略（重入保护）', async () => {
    const { fetch, requests } = mockFetch([
      streamingSseResponse(textStreamChunks('长回复...')),
      sseResponse(textStreamChunks('不该被请求')),
    ])
    const chat = new Chat({ api: '/api/chat', fetch })
    const first = chat.sendMessage({ text: '第一条' })
    await waitFor(30)
    expect(chat.status).toBe('streaming')
    await chat.sendMessage({ text: '第二条' })
    await first
    expect(requests).toHaveLength(1)
  })

  it('自定义 body/headers 函数被解析进请求', async () => {
    const { fetch, requests } = mockFetch([sseResponse(textStreamChunks('ok'))])
    const chat = new Chat({
      api: '/api/chat',
      fetch,
      body: () => ({ model: 'mimo-v2.5' }),
      headers: () => ({ Authorization: 'Bearer test' }),
    })
    await chat.sendMessage({ text: 'hi' })
    expect(requests[0].body.model).toBe('mimo-v2.5')
    expect((requests[0].init.headers as any).Authorization).toBe('Bearer test')
  })
})

describe('Chat 工具回路', () => {
  const toolTurn: UIMessageChunk[] = [
    { type: 'start', messageId: 'a1' },
    { type: 'start-step' },
    { type: 'tool-input-start', toolCallId: 'call-1', toolName: 'get_weather' },
    { type: 'tool-input-delta', toolCallId: 'call-1', inputTextDelta: '{"city":"北' },
    { type: 'tool-input-delta', toolCallId: 'call-1', inputTextDelta: '京"}' },
    { type: 'tool-input-available', toolCallId: 'call-1', toolName: 'get_weather', input: { city: '北京' } },
    { type: 'finish-step' },
    { type: 'finish', finishReason: 'tool-calls' },
  ]

  it('单工具：onToolCall → addToolOutput → 自动续跑第二轮文本', async () => {
    const { fetch, requests } = mockFetch([sseResponse(toolTurn), sseResponse(textStreamChunks('北京今天35度，晴'))])
    const toolCalls: any[] = []
    const chat = new Chat({
      api: '/api/chat',
      fetch,
      sendAutomaticallyWhen: AUTO_SUBMIT,
      onToolCall: ({ toolCall }) => {
        toolCalls.push(toolCall)
        void chat.addToolOutput({ toolCallId: toolCall.toolCallId, output: { temperature: 35, condition: '晴' } })
      },
    })

    await chat.sendMessage({ text: '北京天气怎么样？' })

    expect(toolCalls).toEqual([{ toolCallId: 'call-1', toolName: 'get_weather', input: { city: '北京' } }])
    expect(requests).toHaveLength(2)
    // 第二轮请求带上工具输出
    const secondMessages = requests[1].body.messages as UIMessage[]
    const assistantWithTool = secondMessages.find((m) => m.role === 'assistant')
    expect(assistantWithTool?.parts.some((p) => (p as any).state === 'output-available')).toBe(true)
    // 最终回复是新的 assistant 消息
    expect(chat.messages).toHaveLength(3)
    expect(chat.messages[2].parts.some((p) => p.type === 'text' && (p as any).text === '北京今天35度，晴')).toBe(true)
    expect(chat.status).toBe('ready')
  })

  it('多工具：两个输出都补齐后才续跑', async () => {
    const twoTools: UIMessageChunk[] = [
      { type: 'start', messageId: 'a1' },
      { type: 'start-step' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'get_weather', input: { city: '北京' } },
      { type: 'tool-input-available', toolCallId: 'c2', toolName: 'get_time', input: { zone: 'Asia/Shanghai' } },
      { type: 'finish-step' },
      { type: 'finish', finishReason: 'tool-calls' },
    ]
    const { fetch, requests } = mockFetch([sseResponse(twoTools), sseResponse(textStreamChunks('汇总完成'))])
    const outputs: string[] = []
    const chat = new Chat({
      api: '/api/chat',
      fetch,
      sendAutomaticallyWhen: AUTO_SUBMIT,
      onToolCall: ({ toolCall }) => {
        void chat.addToolOutput({ toolCallId: toolCall.toolCallId, output: { ok: true } })
        outputs.push(toolCall.toolCallId)
      },
    })

    await chat.sendMessage({ text: '查天气和时间' })

    expect(outputs).toEqual(['c1', 'c2'])
    expect(requests).toHaveLength(2)
  })

  it('工具输出 error 时也视为完成并续跑（对齐 AI SDK 语义）', async () => {
    const { fetch, requests } = mockFetch([sseResponse(toolTurn), sseResponse(textStreamChunks('查询失败了，换个方式'))])
    const chat = new Chat({
      api: '/api/chat',
      fetch,
      sendAutomaticallyWhen: AUTO_SUBMIT,
      onToolCall: ({ toolCall }) => {
        void chat.addToolOutput({ toolCallId: toolCall.toolCallId, state: 'output-error', errorText: '上游超时' })
      },
    })
    await chat.sendMessage({ text: '北京天气' })
    expect(requests).toHaveLength(2)
    const lastAssistant = chat.messages[1]
    expect(lastAssistant.parts.some((p) => (p as any).state === 'output-error')).toBe(true)
  })

  it('未配置 sendAutomaticallyWhen 时不续跑', async () => {
    const { fetch, requests } = mockFetch([sseResponse(toolTurn)])
    const chat = new Chat({
      api: '/api/chat',
      fetch,
      onToolCall: ({ toolCall }) => {
        void chat.addToolOutput({ toolCallId: toolCall.toolCallId, output: { ok: true } })
      },
    })
    await chat.sendMessage({ text: 'hi' })
    expect(requests).toHaveLength(1)
    expect(chat.status).toBe('ready')
  })

  it('onToolCall 里 await addToolOutput 会死锁 → 文档行为：fire-and-forget 不阻塞', async () => {
    // 该测试保证 onToolCall 在流处理中被 await，但 addToolOutput 不需要等待流结束即可更新状态
    const { fetch } = mockFetch([sseResponse(toolTurn), sseResponse(textStreamChunks('续跑成功'))])
    const chat = new Chat({
      api: '/api/chat',
      fetch,
      sendAutomaticallyWhen: AUTO_SUBMIT,
      onToolCall: ({ toolCall }) => {
        // 故意不同步等待，模拟 admin 中"void addToolOutput"的用法
        void chat.addToolOutput({ toolCallId: toolCall.toolCallId, output: { ok: 1 } })
      },
    })
    await chat.sendMessage({ text: 'hi' })
    expect(chat.status).toBe('ready')
    expect(chat.messages).toHaveLength(3)
  })
})

describe('Chat 中断与错误', () => {
  it('stop() 中断流式：保留半截文本，状态收敛 ready', async () => {
    // 手工构造 fetch，拿到 signal 构造可中断流
    const fetchFn = (async (_url: any, init?: RequestInit) => {
      return streamingSseResponse(textStreamChunks('这是一段很长很长'), init?.signal, 15)
    }) as unknown as typeof globalThis.fetch

    const chat = new Chat({ api: '/api/chat', fetch: fetchFn })
    const sendPromise = chat.sendMessage({ text: '讲个长故事' })
    await waitForCondition(() => chat.status === 'streaming')
    // 等到至少一个 text-delta 真正到达（chunk 顺序：start/start-step/text-start/delta...）
    const assistantText = () =>
      (chat.messages[1]?.parts.filter((p) => p.type === 'text')[0] as any)?.text ?? ''
    await waitForCondition(() => assistantText().length > 0)
    chat.stop()
    await sendPromise

    expect(chat.status).toBe('ready')
    const text = chat.messages[1].parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
    expect(text.startsWith('这是一段')).toBe(true)
    expect(chat.messages[1].parts.some((p) => p.type === 'text' && (p as any).state === 'streaming')).toBe(false)
  })

  it('error chunk → 状态 error + onError 回调', async () => {
    const { fetch } = mockFetch([
      sseResponse([
        { type: 'start', messageId: 'a1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '部分' },
        { type: 'error', errorText: '渠道炸了' },
      ]),
    ])
    const onError = vi.fn()
    const chat = new Chat({ api: '/api/chat', fetch, onError })
    await chat.sendMessage({ text: 'hi' })
    expect(chat.status).toBe('error')
    expect(chat.error?.message).toBe('渠道炸了')
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: '渠道炸了' }))
    // 已流出的部分文本保留
    expect(chat.messages[1].parts.some((p) => p.type === 'text' && (p as any).text === '部分')).toBe(true)
  })

  it('fetch 网络失败 → 状态 error + onError', async () => {
    const { fetch } = mockFetch([new Error('network down')])
    const onError = vi.fn()
    const chat = new Chat({ api: '/api/chat', fetch, onError })
    await chat.sendMessage({ text: 'hi' })
    expect(chat.status).toBe('error')
    expect(chat.error?.message).toContain('network down')
  })

  it('HTTP 500 → 状态 error，错误信息含响应体', async () => {
    const { fetch } = mockFetch([new Response('upstream exploded', { status: 500 })])
    const chat = new Chat({ api: '/api/chat', fetch })
    await chat.sendMessage({ text: 'hi' })
    expect(chat.status).toBe('error')
    expect(chat.error?.message).toContain('upstream exploded')
  })
})

describe('Chat 会话适配器', () => {
  it('createServerHistoryAdapter：请求只带最后一条消息', async () => {
    const { fetch, requests } = mockFetch([
      sseResponse(textStreamChunks('第一轮')),
      sseResponse(textStreamChunks('第二轮')),
    ])
    const chat = new Chat({ api: '/api/chat', fetch, adapter: createServerHistoryAdapter({ send: 'last' }) })
    await chat.sendMessage({ text: '第一问' })
    await chat.sendMessage({ text: '第二问' })
    // 第二轮请求只包含最后一条（本轮 user 消息）
    const lastBody = requests[1].body
    expect(lastBody.messages).toHaveLength(1)
    expect(lastBody.messages[0].parts[0].text).toBe('第二问')
  })

  it('createLocalHistoryAdapter：全量历史回传 + save 防抖持久化', async () => {
    const { fetch, requests } = mockFetch([
      sseResponse(textStreamChunks('第一轮')),
      sseResponse(textStreamChunks('第二轮')),
    ])
    const saved: UIMessage[][] = []
    const chat = new Chat({
      api: '/api/chat',
      fetch,
      adapter: {
        ...createLocalHistoryAdapter<UIMessage>(),
        save: (messages) => {
          saved.push(messages)
        },
      },
    })
    await chat.sendMessage({ text: '第一问' })
    await chat.sendMessage({ text: '第二问' })
    // 第二轮请求带全量历史（user/assistant/user）
    expect(requests[1].body.messages).toHaveLength(3)
    await waitFor(20) // 等 trailing 批量 flush
    expect(saved.length).toBeGreaterThan(0)
    // 防抖结束后最后一份包含完整 4 条
    await waitFor(260)
    expect(saved[saved.length - 1]).toHaveLength(4)
  })

  it('自定义 load 适配器：hydrate 注入历史消息', async () => {
    const history: UIMessage[] = [
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: '旧问题' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: '旧回答' }] },
    ]
    const adapter: ChatAdapter<UIMessage> = { load: () => history }
    const { fetch } = mockFetch([sseResponse(textStreamChunks('新回答'))])
    const chat = new Chat({ api: '/api/chat', fetch, adapter })
    await chat.ready
    expect(chat.messages).toHaveLength(2)
    await chat.sendMessage({ text: '新问题' })
    expect(chat.messages).toHaveLength(4)
  })

  it('persistSession=false 的 submit：onMessage 同步出去且消息不跨轮保留', async () => {
    const { fetch, requests } = mockFetch([
      sseResponse(textStreamChunks('回答甲')),
      sseResponse(textStreamChunks('回答乙')),
    ])
    const chat = new Chat({ api: '/api/chat', fetch, adapter: createServerHistoryAdapter() })
    const seen: string[] = []
    await chat.submit({ onMessage: (type, message) => seen.push(`${type}:${message.role}`) })
    await chat.submit({ onMessage: (type, message) => seen.push(`${type}:${message.role}`) })
    // 第二次 submit 重建 state，只包含新 assistant 消息
    expect(chat.messages).toHaveLength(1)
    expect(chat.messages[0].role).toBe('assistant')
    expect(seen.filter((s) => s.startsWith('push'))).toHaveLength(2)
  })
})

describe('lastAssistantMessageIsCompleteWithToolCalls', () => {
  const asst = (parts: any[]): UIMessage => ({ id: 'a', role: 'assistant', parts })

  it('空消息 / 非 assistant → false', () => {
    expect(AUTO_SUBMIT({ messages: [] })).toBe(false)
    expect(AUTO_SUBMIT({ messages: [{ id: 'u', role: 'user', parts: [] }] })).toBe(false)
  })

  it('最后一个 step 的工具全部有输出 → true', () => {
    expect(
      AUTO_SUBMIT({
        messages: [
          asst([
            { type: 'step-start' },
            { type: 'tool-get_weather', toolCallId: 'c1', state: 'output-available', input: {}, output: {} },
            { type: 'text', text: 'ok' },
            { type: 'step-start' },
            { type: 'tool-get_time', toolCallId: 'c2', state: 'output-available', input: {}, output: {} },
          ]),
        ],
      }),
    ).toBe(true)
  })

  it('前一步工具有输出但当前 step 还挂着 input-available → false', () => {
    expect(
      AUTO_SUBMIT({
        messages: [
          asst([
            { type: 'step-start' },
            { type: 'tool-a', toolCallId: 'c1', state: 'output-available', input: {}, output: {} },
            { type: 'step-start' },
            { type: 'tool-b', toolCallId: 'c2', state: 'input-available', input: {} },
          ]),
        ],
      }),
    ).toBe(false)
  })

  it('providerExecuted 的工具不算在判断内', () => {
    expect(
      AUTO_SUBMIT({
        messages: [
          asst([
            { type: 'step-start' },
            { type: 'tool-web', toolCallId: 'c1', state: 'input-available', input: {}, providerExecuted: true },
          ]),
        ],
      }),
    ).toBe(false)
  })

  it('output-error 也算完成', () => {
    expect(
      AUTO_SUBMIT({
        messages: [
          asst([{ type: 'tool-a', toolCallId: 'c1', state: 'output-error', errorText: 'x' }]),
        ],
      }),
    ).toBe(true)
  })
})

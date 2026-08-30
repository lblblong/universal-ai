import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Chat } from '../../src/chat/chat'
import { lastAssistantMessageIsCompleteWithToolCalls } from '../../src/chat/last-assistant-message-is-complete-with-tool-calls'
import { callCompletion } from '../../src/completion/call-completion'
import { createLocalHistoryAdapter, type ChatAdapter } from '../../src/adapter'
import type { UIMessage } from '../../src/types/message'
import { startBridgeServer } from '../helpers/bridge-server'

const API_KEY = process.env.OPENCODE_GO_API_KEY
// 无 key 时跳过（单元测试不受影响；本地测试把 key 放进 test/.env）
const suite = API_KEY ? describe : describe.skip

suite('OpenCode Go 真实 API 集成', () => {
  let port: number
  let close: () => Promise<void>
  const upstreamCalls: Array<{ model: string; messageCount: number; toolNames: string[] }> = []

  beforeAll(async () => {
    const { server, port: p } = await startBridgeServer({
      apiKey: API_KEY!,
      onUpstreamCall: (info) => upstreamCalls.push(info),
    })
    port = p
    close = () => new Promise((resolve) => server.close(() => resolve()))
  }, 30_000)

  afterAll(async () => {
    await close()
  })

  it('mimo-v2.5：Chat 基础流式对话', async () => {
    const chat = new Chat({
      api: `http://127.0.0.1:${port}/api/chat`,
      body: { model: 'mimo-v2.5' },
    })
    await chat.sendMessage({ text: '用一句话介绍你自己。' })

    expect(chat.status).toBe('ready')
    expect(chat.messages).toHaveLength(2)
    const assistantText = chat.messages[1].parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as any).text)
      .join('')
    expect(assistantText.length).toBeGreaterThan(4)
    expect(chat.messages[1].parts.some((p) => p.type === 'step-start')).toBe(true)
  }, 120_000)

  it('mimo-v2.5：多轮工具调用回路（客户端执行 get_weather，模型基于工具结果作答）', async () => {
    upstreamCalls.length = 0
    const toolCalls: Array<{ toolName: string; input: any }> = []
    const chat = new Chat({
      api: `http://127.0.0.1:${port}/api/chat`,
      body: {
        model: 'mimo-v2.5',
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: '查询指定城市的实时天气',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string', description: '城市名' } },
                required: ['city'],
              },
            },
          },
        ],
      },
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onToolCall: ({ toolCall }) => {
        const input = toolCall.input as { city?: string }
        toolCalls.push({ toolName: toolCall.toolName, input })
        void chat.addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: { city: input.city ?? '未知', temperature: 35, condition: '晴', forecast: '全天晴朗，最高气温35度' },
        })
      },
    })

    await chat.sendMessage({ text: '请调用 get_weather 工具查询北京今天的天气，然后告诉我结果。' })

    expect(chat.status).toBe('ready')
    // 模型确实发起了工具调用
    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
    expect(toolCalls[0].toolName).toBe('get_weather')
    // 至少两次上游调用：首轮工具调用 + 工具结果续跑
    expect(upstreamCalls.length).toBeGreaterThanOrEqual(2)
    // 第一条 assistant 消息带着工具输出
    const assistantWithTool = chat.messages.find(
      (m) => m.role === 'assistant' && m.parts.some((p) => (p as any).state === 'output-available'),
    )
    expect(assistantWithTool).toBeDefined()
    // 最终回复引用了工具返回的内容（35 度）
    const finalText = chat.messages[chat.messages.length - 1].parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as any).text)
      .join('')
    expect(finalText.length).toBeGreaterThan(0)
    expect(finalText).toContain('35')
  }, 180_000)

  it('hy3：带工具的多轮对话（同一回路跨模型验证）', async () => {
    upstreamCalls.length = 0
    const toolCalls: Array<{ toolName: string }> = []
    const chat = new Chat({
      api: `http://127.0.0.1:${port}/api/chat`,
      body: {
        model: 'hy3',
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_time',
              description: '获取当前时间',
              parameters: { type: 'object', properties: { zone: { type: 'string' } }, required: ['zone'] },
            },
          },
        ],
      },
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onToolCall: ({ toolCall }) => {
        toolCalls.push({ toolName: toolCall.toolName })
        void chat.addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: { zone: 'Asia/Shanghai', time: '2026-08-29 22:30:00', weekday: '周六' },
        })
      },
    })

    await chat.sendMessage({ text: '调用 get_time 工具查一下现在几点了，直接告诉我时间。' })

    expect(chat.status).toBe('ready')
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0].toolName).toBe('get_time')
    expect(upstreamCalls.length).toBeGreaterThanOrEqual(2)
    const finalText = chat.messages[chat.messages.length - 1].parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as any).text)
      .join('')
    expect(finalText).toContain('22:30')
  }, 180_000)

  it('mimo-v2.5：多轮会话 + 本地历史，模型记住上下文暗号', async () => {
    const saved: UIMessage[][] = []
    const adapter: ChatAdapter<UIMessage> = {
      ...createLocalHistoryAdapter<UIMessage>(),
      save: (messages) => saved.push(messages),
    }
    const chat = new Chat({
      api: `http://127.0.0.1:${port}/api/chat`,
      body: { model: 'mimo-v2.5' },
      adapter,
    })

    await chat.sendMessage({ text: '记住：我们的暗号是"芝麻开门"。只回复"好的"。' })
    expect(chat.status).toBe('ready')

    await chat.sendMessage({ text: '暗号是什么？' })
    expect(chat.status).toBe('ready')
    expect(chat.messages).toHaveLength(4)
    const finalText = chat.messages[3].parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as any).text)
      .join('')
    expect(finalText).toContain('芝麻开门')
    expect(saved.length).toBeGreaterThan(0)
  }, 180_000)

  it('callCompletion（data 协议）：单次补全返回完整文本', async () => {
    const progressions: string[] = []
    const { completion, message } = await callCompletion({
      api: `http://127.0.0.1:${port}/api/chat`,
      messages: [{ role: 'user', content: '只回复两个字：收到' }],
      body: { model: 'mimo-v2.5' },
      onCompletion: (text) => progressions.push(text),
    })
    expect(completion).toContain('收到')
    expect((message.parts[0] as any).text).toBe(completion)
    expect(progressions.length).toBeGreaterThan(1)
    expect(progressions[progressions.length - 1]).toBe(completion)
  }, 120_000)

  it('mimo-v2.5：注入数组绑定——真实流式下引用稳定、单条赋值、快照不可变', async () => {
    const bound: UIMessage[] = []
    const chat = new Chat({
      api: `http://127.0.0.1:${port}/api/chat`,
      body: { model: 'mimo-v2.5' },
      messages: bound,
    })
    expect(chat.messages).toBe(bound)

    await chat.sendMessage({ text: '用一句话介绍你自己。' })

    expect(chat.status).toBe('ready')
    expect(chat.messages).toBe(bound)
    expect(bound).toHaveLength(2)
    const assistantText = bound[1].parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as any).text)
      .join('')
    expect(assistantText.length).toBeGreaterThan(4)
  }, 120_000)

  it('mimo-v2.5：注入数组 + 多轮工具调用（真实模型协调回路）', async () => {
    upstreamCalls.length = 0
    const bound: UIMessage[] = []
    const chat = new Chat({
      api: `http://127.0.0.1:${port}/api/chat`,
      body: {
        model: 'mimo-v2.5',
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: '查询指定城市的实时天气',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string', description: '城市名' } },
                required: ['city'],
              },
            },
          },
        ],
      },
      messages: bound,
      sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
      onToolCall: ({ toolCall }) => {
        void chat.addToolOutput({
          toolCallId: toolCall.toolCallId,
          output: { temperature: 35, condition: '晴' },
        })
      },
    })

    await chat.sendMessage({ text: '调用 get_weather 查北京天气，然后告诉我结果。' })

    expect(chat.status).toBe('ready')
    expect(chat.messages).toBe(bound)
    expect(upstreamCalls.length).toBeGreaterThanOrEqual(2)
    // 消息数组：user → assistant(带工具输出) → assistant(最终回答)
    expect(bound).toHaveLength(3)
    expect(bound[1].parts.some((p) => (p as any).state === 'output-available')).toBe(true)
    const finalText = bound[2].parts
      .filter((p) => p.type === 'text')
      .map((p) => (p as any).text)
      .join('')
    expect(finalText).toContain('35')
  }, 180_000)
})

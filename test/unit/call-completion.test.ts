import { describe, expect, it, vi } from 'vitest'
import { callCompletion } from '../../src/completion/call-completion'
import { mockFetch, sseResponse, sseResponseFromText, streamingSseResponse } from '../helpers/sse'

const waitFor = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('callCompletion（data 协议）', () => {
  it('累积 text-delta 并返回完整 completion', async () => {
    const { fetch } = mockFetch([
      sseResponse([
        { type: 'start', messageId: 'a1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '你' },
        { type: 'text-delta', id: 't1', delta: '好' },
        { type: 'text-end', id: 't1' },
        { type: 'finish' },
      ]),
    ])
    const progressions: string[] = []
    const { completion, message } = await callCompletion({
      api: '/api/chat',
      messages: [{ role: 'user', content: '打个招呼' }],
      fetch,
      onCompletion: (text) => progressions.push(text),
    })

    expect(completion).toBe('你好')
    expect(message.parts[0]).toEqual({ type: 'text', text: '你好' })
    // 渐进回调：初始空串 + 每个 delta
    expect(progressions).toEqual(['', '你', '你好'])
  })

  it('SimpleMessage 转换为 parts 结构发送', async () => {
    const { fetch, requests } = mockFetch([sseResponse([{ type: 'text-delta', id: 't', delta: 'x' }])])
    await callCompletion({
      api: '/api/chat',
      messages: [{ role: 'user', content: 'hi' }],
      fetch,
    })
    expect(requests[0].body.messages[0]).toEqual({
      role: 'user',
      parts: [{ type: 'text', text: 'hi' }],
    })
  })

  it('额外 body 合入请求', async () => {
    const { fetch, requests } = mockFetch([sseResponse([])])
    await callCompletion({
      api: '/api/chat',
      messages: [],
      body: { model: 'hy3' },
      fetch,
    })
    expect(requests[0].body.model).toBe('hy3')
  })

  it('error chunk → 抛出错误', async () => {
    const { fetch } = mockFetch([sseResponse([{ type: 'error', errorText: '上游错误' }])])
    await expect(
      callCompletion({ api: '/api/chat', messages: [], fetch }),
    ).rejects.toThrow('上游错误')
  })

  it('非法 JSON 数据 → 抛出解析错误', async () => {
    const { fetch } = mockFetch([sseResponseFromText('data: {broken\n\n')])
    await expect(
      callCompletion({ api: '/api/chat', messages: [], fetch }),
    ).rejects.toThrow()
  })

  it('HTTP 非 200 → 抛出响应体文本', async () => {
    const { fetch } = mockFetch([new Response('quota exceeded', { status: 429 })])
    await expect(
      callCompletion({ api: '/api/chat', messages: [], fetch }),
    ).rejects.toThrow('quota exceeded')
  })

  it('abortController 可中断请求', async () => {
    const abortController = new AbortController()
    const fetchFn = (async (_url: any, init?: RequestInit) =>
      streamingSseResponse([{ type: 'text-delta', id: 't', delta: 'a' }], init?.signal, 10)) as unknown as typeof globalThis.fetch
    const promise = callCompletion({
      api: '/api/chat',
      messages: [],
      fetch: fetchFn,
      abortController,
    })
    await waitFor(30)
    abortController.abort()
    // 中断后请求应以 AbortError 结束
    await expect(promise).rejects.toThrow()
  })
})

describe('callCompletion（text 协议）', () => {
  it('纯文本流累积', async () => {
    const { fetch } = mockFetch([
      sseResponseFromText('第一段\n第二段'),
    ])
    const progressions: string[] = []
    const { completion } = await callCompletion({
      api: '/api/chat',
      messages: [],
      fetch,
      streamProtocol: 'text',
      onCompletion: (text) => progressions.push(text),
    })
    expect(completion).toBe('第一段\n第二段')
    expect(progressions[progressions.length - 1]).toBe('第一段\n第二段')
  })
})

import { describe, expect, it } from 'vitest'
import { createEventSourceParserStream, feedSseText, type EventSourceMessage } from '../../src/sse/event-source-parser-stream'
import { parseJsonEventStream } from '../../src/sse/parse-json-event-stream'
import { byteChunks, sseResponseFromBytes, sseResponseFromText } from '../helpers/sse'

async function collect<T>(stream: ReadableStream<T>): Promise<T[]> {
  const result: T[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    result.push(value)
  }
  return result
}

function parseSseText(text: string): EventSourceMessage[] {
  const state = { buffer: '', dataLines: [] as string[], eventName: 'message' } as any
  return feedSseText(state, text).messages
}

describe('event-source-parser-stream', () => {
  it('解析单个 data 事件', () => {
    const events = parseSseText('data: {"type":"start"}\n\n')
    expect(events).toEqual([{ data: '{"type":"start"}', event: 'message', id: undefined }])
  })

  it('解析多个连续事件', () => {
    const events = parseSseText('data: 1\n\ndata: 2\n\ndata: 3\n\n')
    expect(events.map((e) => e.data)).toEqual(['1', '2', '3'])
  })

  it('多行 data 用 \\n 拼接', () => {
    const events = parseSseText('data: line1\ndata: line2\n\n')
    expect(events[0].data).toBe('line1\nline2')
  })

  it('忽略冒号注释行与空 data 事件', () => {
    const events = parseSseText(': keep-alive\n\ndata: real\n\n')
    expect(events.map((e) => e.data)).toEqual(['real'])
  })

  it('支持 CRLF 分隔', () => {
    const events = parseSseText('data: a\r\n\r\ndata: b\r\n\r\n')
    expect(events.map((e) => e.data)).toEqual(['a', 'b'])
  })

  it('跨包半截事件正确缓冲', () => {
    const state = { buffer: '', dataLines: [] as string[], eventName: 'message' } as any
    const first = feedSseText(state, 'data: {"type":"te')
    expect(first.messages).toEqual([])
    const second = feedSseText(state, 'xt"}\n\ndata: x\n\n')
    expect(second.messages.map((m) => m.data)).toEqual(['{"type":"text"}', 'x'])
  })

  it('流中途半截事件在 flush 时按完整事件派发', async () => {
    const bytes = byteChunks('data: {"a":1}\n\ndata: {"b":2}', 3)
    const events = await collect(sseResponseFromBytes(bytes).body!.pipeThrough(createEventSourceParserStream()))
    expect(events.map((e) => JSON.parse(e.data))).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('字节级分包不丢事件', async () => {
    const text = 'data: {"type":"text-delta","id":"t1","delta":"你好"}\n\ndata: {"type":"finish"}\n\n'
    const bytes = byteChunks(text, 1)
    const events = await collect(sseResponseFromBytes(bytes).body!.pipeThrough(createEventSourceParserStream()))
    expect(events).toHaveLength(2)
  })

  it('TransformStream 端到端：字节流 → 事件流', async () => {
    const text = 'data: {"a":1}\n\n:data:comment\ndata: {"a":2}\n\n'
    const bytes = byteChunks(text, 7)
    const events = await collect(sseResponseFromBytes(bytes).body!.pipeThrough(createEventSourceParserStream()))
    expect(events.map((e) => JSON.parse(e.data))).toEqual([{ a: 1 }, { a: 2 }])
  })
})

describe('parse-json-event-stream', () => {
  it('解析 JSON 数据流', async () => {
    const response = sseResponseFromText('data: {"type":"start"}\n\ndata: {"type":"finish"}\n\n')
    const values = await collect(parseJsonEventStream({ stream: response.body! }))
    expect(values.map((v) => (v as any).value?.type)).toEqual(['start', 'finish'])
    expect(values.every((v) => v.success)).toBe(true)
  })

  it('忽略 [DONE]', async () => {
    const response = sseResponseFromText('data: [DONE]\n\ndata: {"a":1}\n\n')
    const values = await collect(parseJsonEventStream({ stream: response.body! }))
    expect(values).toHaveLength(1)
  })

  it('非法 JSON 产出 success: false 而不炸流', async () => {
    const response = sseResponseFromText('data: {broken\n\ndata: {"ok":true}\n\n')
    const values = await collect(parseJsonEventStream({ stream: response.body! }))
    expect(values).toHaveLength(2)
    expect(values[0].success).toBe(false)
    expect(values[1]).toEqual({ success: true, value: { ok: true } })
  })
})

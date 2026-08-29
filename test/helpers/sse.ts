import type { UIMessageChunk } from '../../src/types/chunk'

/**
 * 把 chunk 序列编码为 UI message stream 的 SSE 字节流，
 * 用于 mock fetch 返回，行为与 AI SDK toUIMessageStream 的线格式一致。
 */
export function sseResponse(chunks: UIMessageChunk[] | string[], options: ResponseInit = {}): Response {
  const events = chunks.map((chunk) => {
    const payload = typeof chunk === 'string' ? chunk : JSON.stringify(chunk)
    return `data: ${payload}\n\n`
  })
  return sseResponseFromText(events.join(''), options)
}

export function sseResponseFromText(text: string, options: ResponseInit = {}): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
    ...options,
  })
}

/**
 * 把 SSE 文本切成多段字节块，模拟网络分包（用于测半截事件的缓冲）。
 */
export function byteChunks(text: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text)
  const result: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) {
    result.push(bytes.slice(i, i + size))
  }
  return result
}

/** 可编程分包的 SSE 响应 */
export function sseResponseFromBytes(bytes: Uint8Array[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of bytes) controller.enqueue(chunk)
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/** 构造 fetch mock：按调用次序返回预设响应，并记录请求 */
export function mockFetch(responses: Array<Response | Error>, onRequest?: (info: { url: string; body: any; init: RequestInit }) => void) {
  const requests: Array<{ url: string; body: any; init: RequestInit }> = []
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const body = init?.body ? JSON.parse(init.body as string) : undefined
    requests.push({ url, body, init: init ?? {} })
    onRequest?.({ url, body, init: init ?? {} })
    const next = responses.shift()
    if (!next) throw new Error('mockFetch: no more queued responses')
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof globalThis.fetch
  return { fetch: fn, requests }
}

export function sseTextChunks(chunks: UIMessageChunk[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('')
}

export const textStreamChunks = (text: string): UIMessageChunk[] => [
  { type: 'start', messageId: 'assistant-1' },
  { type: 'start-step' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: text },
  { type: 'text-end', id: 't1' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
]

/**
 * 流式 SSE 响应：每隔 interval 发一个 chunk；提供 signal 时，
 * abort 会以 AbortError 中断读取（模拟真实 fetch 的行为）。
 */
export function streamingSseResponse(
  chunks: UIMessageChunk[],
  signal?: AbortSignal,
  interval = 10,
): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const chunk of chunks) {
        if (signal?.aborted) {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'))
          return
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        await new Promise((r) => setTimeout(r, interval))
      }
      // 保持流打开，直到外部 abort（模拟长回复被用户打断）
      if (signal) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            controller.error(new DOMException('The operation was aborted.', 'AbortError'))
            resolve()
          })
        })
      }
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
}

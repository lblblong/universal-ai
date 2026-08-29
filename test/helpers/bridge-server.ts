import { createServer, type Server } from 'node:http'
import type { UIMessage } from '../../src/types/message'

/**
 * 本地协议桥接服务（仅测试用）：
 * 客户端（universal-ai）→ UI message stream 协议 → 桥接服务
 * 桥接服务 → OpenAI chat completions 协议 → OpenCode Go 真实 API
 *
 * 相当于 aidianshang api 的 Completion 端点在测试环境里的最小等价物，
 * 用已知良好的 OpenAI SSE 解析隔离被测库，避免自我验证。
 */

export interface BridgeToolCall {
  toolCallId: string
  toolName: string
  input: unknown
}

export interface BridgeOptions {
  apiKey: string
  baseUrl?: string
  /** 观测上游调用（断言多轮续跑次数用） */
  onUpstreamCall?: (info: { model: string; messageCount: number; toolNames: string[] }) => void
}

interface OpenAiChunk {
  choices?: Array<{
    delta?: { content?: string | null; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }
    finish_reason?: string | null
  }>
}

/** UIMessage（或 callCompletion 的精简消息）→ OpenAI messages */
function toOpenAiMessages(messages: any[]): any[] {
  const result: any[] = []
  for (const msg of messages) {
    const role = msg.role
    const parts: any[] = Array.isArray(msg.parts) ? msg.parts : []
    if (role === 'user') {
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('')
      result.push({ role: 'user', content: text || msg.content || '' })
      continue
    }
    if (role === 'assistant') {
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('')
      const toolParts = parts.filter(
        (p) => (p.type === 'dynamic-tool' || p.type?.startsWith('tool-')) && (p.state === 'input-available' || p.state === 'output-available'),
      )
      if (toolParts.length > 0) {
        result.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolParts.map((p) => ({
            id: p.toolCallId,
            type: 'function',
            function: {
              name: p.type === 'dynamic-tool' ? p.toolName : p.type.slice('tool-'.length),
              arguments: JSON.stringify(p.input ?? {}),
            },
          })),
        })
        for (const p of toolParts) {
          const toolResult =
            p.state === 'output-error' ? { error: p.errorText ?? 'tool failed' } : (p.output ?? { ok: true })
          result.push({ role: 'tool', tool_call_id: p.toolCallId, content: JSON.stringify(toolResult) })
        }
      } else {
        result.push({ role: 'assistant', content: text || msg.content || '' })
      }
      continue
    }
    // system 等
    result.push({ role, content: msg.content ?? '' })
  }
  return result
}

function toolNameOf(part: any): string {
  return part.type === 'dynamic-tool' ? part.toolName : part.type.slice('tool-'.length)
}

/** 解析 OpenAI SSE 字节流，回调每个 JSON chunk */
async function readUpstreamSse(body: ReadableStream<Uint8Array>, onChunk: (chunk: OpenAiChunk) => void) {
  const decoder = new TextDecoder()
  let buffer = ''
  const reader = body.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index: number
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (!data || data === '[DONE]') continue
      try {
        onChunk(JSON.parse(data))
      } catch {
        // 忽略无法解析的心跳/杂项行
      }
    }
  }
}

export function startBridgeServer(options: BridgeOptions): Promise<{ server: Server; port: number }> {
  const { apiKey } = options
  const baseUrl = options.baseUrl ?? 'https://opencode.ai/zen/go/v1'

  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.includes('/api/chat')) {
      res.writeHead(404).end()
      return
    }

    const chunks: Uint8Array[] = []
    for await (const piece of req) chunks.push(piece as Uint8Array)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const messages: UIMessage[] = payload.messages ?? []
    const tools: any[] = Array.isArray(payload.tools) && payload.tools.length > 0 ? payload.tools : undefined
    const model: string = payload.model ?? 'mimo-v2.5'

    options.onUpstreamCall?.({
      model,
      messageCount: messages.length,
      toolNames: (tools ?? []).map((t) => t.function?.name).filter(Boolean),
    })

    const upstream = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: toOpenAiMessages(messages),
        stream: true,
        ...(tools ? { tools, tool_choice: 'auto' } : {}),
      }),
    })

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '')
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end(`upstream error ${upstream.status}: ${text}`)
      return
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })

    const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`)

    send({ type: 'start', messageId: `bridge-${Date.now()}` })
    send({ type: 'start-step' })

    let textStarted = false
    let text = ''
    const pendingTools = new Map<number, { id: string; name: string; args: string }>()

    const flushText = () => {
      if (textStarted) {
        send({ type: 'text-end', id: 'bridge-text' })
        textStarted = false
      }
    }

    await readUpstreamSse(upstream.body, (chunk) => {
      const delta = chunk.choices?.[0]?.delta
      if (delta?.content) {
        if (!textStarted) {
          send({ type: 'text-start', id: 'bridge-text' })
          textStarted = true
        }
        text += delta.content
        send({ type: 'text-delta', id: 'bridge-text', delta: delta.content })
      }
      for (const tc of delta?.tool_calls ?? []) {
        const current = pendingTools.get(tc.index) ?? { id: '', name: '', args: '' }
        if (tc.id) current.id = tc.id
        if (tc.function?.name) {
          current.name = tc.function.name
          send({ type: 'tool-input-start', toolCallId: current.id || `call-${tc.index}`, toolName: current.name })
        }
        if (tc.function?.arguments) {
          current.args += tc.function.arguments
          send({ type: 'tool-input-delta', toolCallId: current.id || `call-${tc.index}`, inputTextDelta: tc.function.arguments })
        }
        pendingTools.set(tc.index, current)
      }
    })

    flushText()

    for (const [, tool] of [...pendingTools.entries()].sort((a, b) => a[0] - b[0])) {
      let input: unknown = {}
      try {
        input = tool.args ? JSON.parse(tool.args) : {}
      } catch {
        input = { raw: tool.args }
      }
      send({
        type: 'tool-input-available',
        toolCallId: tool.id || `call-${tool.name}`,
        toolName: tool.name,
        input,
      })
    }

    send({ type: 'finish-step' })
    send({ type: 'finish', finishReason: 'stop' })
    res.end('data: [DONE]\n\n')
  })

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: typeof address === 'object' && address ? address.port : 0 })
    })
  })
}

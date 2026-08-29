/**
 * 极简 SSE（Server-Sent Events）解析器，行为对齐 WHATWG EventSource 规范的
 * 常用子集：按空行分事件、`data:` 行拼接（多行用 \n 连接）、忽略冒号注释行、
 * 跨 chunk 的半截事件正确缓冲。
 *
 * 替代官方 parseJsonEventStream 内部使用的 eventsource-parser 依赖。
 */

export interface EventSourceMessage {
  /** 多行 data 以 \n 拼接后的内容 */
  data: string
  event: string
  id?: string
}

interface ParserState {
  buffer: string
  dataLines: string[]
  eventName: string
  lastEventId?: string
}

function createState(): ParserState {
  return { buffer: '', dataLines: [], eventName: 'message' }
}

function dispatchEvent(state: ParserState): EventSourceMessage | undefined {
  const data = state.dataLines.join('\n')
  const event = state.eventName
  state.dataLines = []
  state.eventName = 'message'
  if (data.length === 0) return undefined
  return { data, event, id: state.lastEventId }
}

function findEventSeparator(buffer: string): number {
  const lf = buffer.indexOf('\n\n')
  const crlf = buffer.indexOf('\r\n\r\n')
  if (lf === -1) return crlf
  if (crlf === -1) return lf
  return Math.min(lf, crlf)
}

function consumeEventLines(state: ParserState, rawEvent: string): EventSourceMessage | undefined {
  for (const rawLine of rawEvent.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') continue
    // 冒号开头是注释行
    if (line.startsWith(':')) continue

    const colonIndex = line.indexOf(':')
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'data') {
      state.dataLines.push(value)
    } else if (field === 'event') {
      state.eventName = value
    } else if (field === 'id') {
      state.lastEventId = value
    }
    // retry 等字段与 JSON 事件流无关，忽略
  }
  return dispatchEvent(state)
}

/**
 * 把一段 SSE 文本喂进解析器，返回产出的完整事件与剩余的未完成前缀。
 */
export function feedSseText(
  state: ParserState,
  text: string,
): { messages: EventSourceMessage[]; remaining: string } {
  state.buffer += text
  const messages: EventSourceMessage[] = []

  let separatorIndex: number
  while ((separatorIndex = findEventSeparator(state.buffer)) !== -1) {
    const rawEvent = state.buffer.slice(0, separatorIndex)
    const separatorLength = state.buffer.startsWith('\r\n', separatorIndex) ? 4 : 2
    state.buffer = state.buffer.slice(separatorIndex + separatorLength)
    const message = consumeEventLines(state, rawEvent)
    if (message) messages.push(message)
  }

  return { messages, remaining: state.buffer }
}

/**
 * 将字节流解析为 SSE 事件流。
 */
export function createEventSourceParserStream(): TransformStream<Uint8Array, EventSourceMessage> {
  const state = createState()
  const decoder = new TextDecoder()
  let buffer = ''

  const decode = (chunk: Uint8Array) => feedSseText(state, decoder.decode(chunk, { stream: true }))

  return new TransformStream<Uint8Array, EventSourceMessage>({
    transform(chunk, controller) {
      const { messages, remaining } = decode(chunk)
      buffer = remaining
      for (const message of messages) controller.enqueue(message)
    },
    flush(controller) {
      const { messages, remaining } = feedSseText(state, decoder.decode())
      buffer = remaining
      for (const message of messages) controller.enqueue(message)
      // 流结束时若还有未终结的事件，按完整事件派发
      const tail = consumeEventLines(state, buffer)
      if (tail) controller.enqueue(tail)
    },
  })
}

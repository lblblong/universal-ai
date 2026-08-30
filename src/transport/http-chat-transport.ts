import { parseJsonEventStream, type ParseResult } from '../sse/parse-json-event-stream'
import type { UIMessageChunk } from '../types/chunk'
import type {
  ChatSendTrigger,
  ChatTransport,
  ChatTransportSendOptions,
} from '../types/chat'
import type { UIMessage } from '../types/message'

/** 值或返回值的函数（同步/异步均可），用于 headers / body 的惰性解析 */
export type Resolvable<T> = T | (() => T | Promise<T>)

export async function resolveResolvable<T>(value: Resolvable<T> | undefined): Promise<T | undefined> {
  if (value == null) return undefined
  return typeof value === 'function' ? (value as () => T | Promise<T>)() : value
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (headers == null) return {}
  if (headers instanceof Headers) {
    const result: Record<string, string> = {}
    headers.forEach((value, key) => {
      result[key] = value
    })
    return result
  }
  if (Array.isArray(headers)) return Object.fromEntries(headers)
  return { ...headers }
}

export interface PrepareSendMessagesRequestOptions<UI_MESSAGE extends UIMessage> {
  id: string
  messages: UI_MESSAGE[]
  body: Record<string, unknown> | undefined
  credentials: RequestCredentials | undefined
  headers: Record<string, string> | Headers | undefined
  api: string
  trigger: ChatSendTrigger
  messageId: string | undefined
}

export interface PreparedRequest {
  body: object
  headers?: HeadersInit
  credentials?: RequestCredentials
  api?: string
}

export type PrepareSendMessagesRequest<UI_MESSAGE extends UIMessage> = (
  options: PrepareSendMessagesRequestOptions<UI_MESSAGE>,
) => PreparedRequest | PromiseLike<PreparedRequest>

export interface DefaultChatTransportOptions<UI_MESSAGE extends UIMessage> {
  api?: string
  credentials?: Resolvable<RequestCredentials>
  headers?: Resolvable<Record<string, string> | Headers>
  body?: Resolvable<object>
  fetch?: typeof globalThis.fetch
  prepareSendMessagesRequest?: PrepareSendMessagesRequest<UI_MESSAGE>
}

/**
 * 默认 HTTP 传输：POST JSON（UI message 协议）→ 解析 SSE → UIMessageChunk 流。
 * 请求体形状对齐 AI SDK 的 UI message stream 协议，服务端无需感知客户端实现。
 */
export class DefaultChatTransport<UI_MESSAGE extends UIMessage = UIMessage>
  implements ChatTransport<UI_MESSAGE>
{
  readonly api: string
  private readonly credentials?: Resolvable<RequestCredentials>
  private readonly headers?: Resolvable<Record<string, string> | Headers>
  private readonly body?: Resolvable<object>
  private readonly fetchImpl: typeof globalThis.fetch
  private readonly prepareSendMessagesRequest?: PrepareSendMessagesRequest<UI_MESSAGE>

  constructor(options: DefaultChatTransportOptions<UI_MESSAGE> = {}) {
    this.api = options.api ?? '/api/chat'
    this.credentials = options.credentials
    this.headers = options.headers
    this.body = options.body
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.prepareSendMessagesRequest = options.prepareSendMessagesRequest
  }

  async sendMessages(
    options: ChatTransportSendOptions<UI_MESSAGE>,
  ): Promise<ReadableStream<UIMessageChunk>> {
    const transportHeaders = headersToObject(await resolveResolvable(this.headers))
    const transportBody = (await resolveResolvable(this.body)) ?? {}
    const transportCredentials = await resolveResolvable(this.credentials)
    const requestHeaders = headersToObject(options.headers)
    // 对齐 AI SDK：transport.body 与单次 send 的 body 先合并，再交给 prepare。
    // 否则自定义 prepareSendMessagesRequest 时 model/tools 会被整包丢掉。
    const mergedBody = { ...transportBody, ...options.body }
    const baseHeaders = { ...transportHeaders, ...requestHeaders }
    const credentials = options.credentials ?? transportCredentials

    const prepared = this.prepareSendMessagesRequest
      ? await this.prepareSendMessagesRequest({
          id: options.id,
          messages: options.messages,
          body: mergedBody,
          credentials,
          headers: baseHeaders,
          api: this.api,
          trigger: options.trigger,
          messageId: options.messageId,
        })
      : {
          body: {
            ...mergedBody,
            id: options.id,
            trigger: options.trigger,
            messageId: options.messageId,
            messages: options.messages,
          },
          headers: baseHeaders,
          credentials,
        }

    const response = await (options.fetch ?? this.fetchImpl)(prepared.api ?? this.api, {
      method: 'POST',
      body: JSON.stringify(prepared.body),
      headers: {
        'Content-Type': 'application/json',
        ...prepared.headers,
      },
      credentials: prepared.credentials,
      signal: options.abortSignal,
    })

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(text || `Failed to fetch the chat response: ${response.status}`)
    }
    if (!response.body) {
      throw new Error('The response body is empty.')
    }

    return parseJsonEventStream<UIMessageChunk>({ stream: response.body }).pipeThrough(
      new TransformStream<ParseResult<UIMessageChunk>, UIMessageChunk>({
        transform(part, controller) {
          if (!part.success) throw part.error
          controller.enqueue(part.value)
        },
      }),
    )
  }
}

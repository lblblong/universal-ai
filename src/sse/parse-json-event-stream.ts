import { createEventSourceParserStream, type EventSourceMessage } from './event-source-parser-stream'

export type ParseResult<T> =
  | { success: true; value: T }
  | { success: false; error: unknown }

/**
 * 把响应字节流解析为 JSON 对象流：字节流 → SSE 事件 → JSON.parse。
 *
 * 对齐 AI SDK parseJsonEventStream 的行为：
 * - 忽略 OpenAI 风格的 `data: [DONE]`
 * - 单条数据解析失败不炸流，产出 { success: false } 由上层决定处理方式
 */
export function parseJsonEventStream<T = unknown>({
  stream,
}: {
  stream: ReadableStream<Uint8Array>
}): ReadableStream<ParseResult<T>> {
  // createEventSourceParserStream 自带字节解码，无需 TextDecoderStream
  return stream
    .pipeThrough(createEventSourceParserStream())
    .pipeThrough(
      new TransformStream<EventSourceMessage, ParseResult<T>>({
        transform({ data }, controller) {
          if (data === '[DONE]') return
          try {
            controller.enqueue({ success: true, value: JSON.parse(data) as T })
          } catch (error) {
            controller.enqueue({ success: false, error })
          }
        },
      }),
    )
}

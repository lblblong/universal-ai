import { parseJsonEventStream, type ParseResult } from '../sse/parse-json-event-stream'
import type { UIMessage } from '../types/message'
import type { UIMessageChunk } from '../types/chunk'

interface SimpleMessage {
  role: 'user' | 'assistant' | 'system' | 'function'
  content: string
}

export async function callCompletion(opts: {
  api: string
  messages: (Omit<UIMessage, 'id'> | SimpleMessage)[]
  abortController?: AbortController | null
  body?: Record<string, any>
  credentials?: RequestCredentials
  headers?: Record<string, string> | Headers
  streamProtocol?: 'text' | 'data'
  onCompletion?: (completion: string, message: Omit<UIMessage, 'id'>) => void
}) {
  const {
    api,
    abortController,
    body,
    credentials,
    headers,
    streamProtocol = 'data',
    onCompletion,
  } = opts

  const messages = opts.messages.map((msg) => {
    if ('content' in msg) {
      return {
        role: msg.role,
        parts: [{ type: 'text', text: msg.content }],
      }
    }
    return msg
  })

  onCompletion?.('', { role: 'assistant', parts: [] })

  const response = await fetch(api, {
    method: 'POST',
    body: JSON.stringify({
      messages,
      ...body,
    }),
    credentials,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    signal: abortController?.signal,
  }).catch((err) => {
    throw err
  })

  if (!response.ok) {
    throw new Error(
      (await response.text()) ?? 'Failed to fetch the chat response.'
    )
  }

  if (!response.body) {
    throw new Error('The response body is empty.')
  }

  let result = ''

  switch (streamProtocol) {
    case 'text': {
      const reader = response.body
        .pipeThrough(new TextDecoderStream() as unknown as TransformStream<Uint8Array, string>)
        .getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        result += value
        onCompletion?.(result, {
          role: 'assistant',
          parts: [{ type: 'text', text: result }],
        })
      }
      break
    }
    case 'data': {
      const chunkStream = parseJsonEventStream<UIMessageChunk>({ stream: response.body })
      for await (const part of chunkStream as ReadableStream<ParseResult<UIMessageChunk>>) {
        if (!part.success) {
          throw part.error
        }

        const streamPart = part.value
        if (streamPart.type === 'text-delta') {
          result += streamPart.delta
          onCompletion?.(result, {
            role: 'assistant',
            parts: [{ type: 'text', text: result }],
          })
        } else if (streamPart.type === 'error') {
          throw new Error(streamPart.errorText)
        }
      }
      break
    }
    default: {
      const exhaustiveCheck: never = streamProtocol
      throw new Error(`Unknown stream protocol: ${exhaustiveCheck}`)
    }
  }

  return {
    completion: result,
    message: { role: 'assistant', parts: [{ type: 'text', text: result }] },
  }
}

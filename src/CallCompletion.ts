import { parseJsonEventStream, ParseResult } from '@ai-sdk/provider-utils'
import { consumeStream, UIMessage, UIMessageChunk } from 'ai'
import { z } from 'zod/v4'
import { processTextStream } from './utils/processTextStream'

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
      await processTextStream({
        stream: response.body,
        onTextPart: (chunk) => {
          result += chunk
          onCompletion?.(result, {
            role: 'assistant',
            parts: [{ type: 'text', text: result }],
          })
        },
      })
      break
    }
    case 'data': {
      await consumeStream({
        stream: parseJsonEventStream({
          stream: response.body,
          schema: z.unknown(),
        }).pipeThrough(
          new TransformStream<ParseResult<UIMessageChunk>, UIMessageChunk>({
            async transform(part) {
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
            },
          })
        ),
        onError: (error) => {
          throw error
        },
      })
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


/**
 * 对着本地 aidianshang-api（localhost:9002）确认 UI message 流里的
 * reasoning-start/delta/end 能被 Chat / processUIMessageStream 归约成
 * `{ type: 'reasoning' }` 部件——管理端思考块渲染依赖这个。
 *
 * 不进默认 `pnpm test`。需要 test/.env 里的 CHAT_API_TOKEN。
 *
 *   pnpm test:reasoning
 *
 * SSE 原文与归约结果写到 test/logs/<stamp>/。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Chat } from '../../src/chat/chat'
import { processUIMessageStream, type UIMessageStreamState } from '../../src/stream/process-ui-message-stream'
import type { UIMessageChunk } from '../../src/types/chunk'
import type { UIMessage } from '../../src/types/message'

const here = dirname(fileURLToPath(import.meta.url))
const TOKEN = process.env.CHAT_API_TOKEN
const API_URL =
  process.env.CHAT_API_URL || 'http://localhost:9002/ai/chat/completions'
const MODEL = process.env.CHAT_MODEL || 'mimo-v2.5'

const suite = TOKEN ? describe : describe.skip

const USER_TEXT = `Turn the reference photo into a travel souvenir enamel pin badge. Compose it as a SCENE, not a single isolated object.

Subject hierarchy: the defining landscape, terrain or landmark of the photo forms the main body of the badge and occupies most of its area. If a person appears prominently in the photo, keep them in the badge as a small, simplified figure at true relative scale within that landscape — the person is an accent, the landscape is the subject. Preserve the original spatial relationship and scale between the figure and the surroundings.

How to render the person: flat enamel color blocks matching their real clothing and hair color from the photo. The face is a smooth plain area of light skin-tone enamel with no drawn facial features — do NOT render the person as a dark or black silhouette, and do NOT black out the face or head. Skin reads as a warm light enamel color, clearly lighter than the clothing.

Styling: thin polished gold outline around the silhouette and along every internal divider, glossy enamel color fill, gentle even lighting with only a soft sheen on the gold lines, very subtle drop shadow. Outer contour follows the scene's own shape, not a plain rectangle.

Background: flat dark navy coarse linen texture. Badge centered, filling about 60% of the frame.

Avoid: black silhouette figure, blacked-out face, dark featureless head, portrait close-up, detailed facial features, person dominating the badge, cropping out the landscape, three-quarter angle, macro product photography, heavy specular glare, cartoon, realistic scene, text, watermark.`

function loadAdminSystemPrompt() {
  const generateTs = resolve(
    here,
    '../../../aidianshang/admin/src/pages/app/form/generate.ts',
  )
  const src = readFileSync(generateTs, 'utf8')
  const match = src.match(
    /export const APP_GENERATE_SYSTEM_PROMPT = `([\s\S]*?)`\n/,
  )
  if (!match) {
    throw new Error(`无法从 ${generateTs} 解析 APP_GENERATE_SYSTEM_PROMPT`)
  }
  return match[1]
}

const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_app_form',
      description:
        '读取当前创意应用表单的可配置字段快照（含 availableModels / paramOptions）。改表前必须先调一次，等结果回来再 apply；本轮最多一次。',
      parameters: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'apply_app_form',
      description:
        '把用户点名要改的字段写入表单。只传需要改的字段；未传的字段保持原值。封面和预置素材不要写。',
      parameters: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        properties: {
          title: { type: 'string' },
          desc: { type: 'string' },
          output: { type: 'string', enum: ['image', 'video'] },
          prompt: { type: 'string' },
          promptLocked: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
  },
]

function chunkTypesOfSse(text: string) {
  const types: string[] = []
  for (const block of text.split('\n\n')) {
    const line = block.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') continue
    try {
      const parsed = JSON.parse(payload) as { type?: string }
      if (parsed.type) types.push(parsed.type)
    } catch {
      types.push(`<unparsed:${payload.slice(0, 40)}>`)
    }
  }
  return types
}

function parseSseChunks(text: string): UIMessageChunk[] {
  const chunks: UIMessageChunk[] = []
  for (const block of text.split('\n\n')) {
    const line = block.trim()
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (!payload || payload === '[DONE]') continue
    chunks.push(JSON.parse(payload) as UIMessageChunk)
  }
  return chunks
}

async function reduceChunks(chunks: UIMessageChunk[]) {
  const state: UIMessageStreamState<UIMessage> = {
    message: { id: 'assistant-1', role: 'assistant', parts: [] },
  }
  const source = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const processed = source.pipeThrough(processUIMessageStream({ state }))
  const reader = processed.getReader()
  while (true) {
    const { done } = await reader.read()
    if (done) break
  }
  return state.message
}

suite('本地 completions 思考流归约', () => {
  it(
    '真实 SSE 含 reasoning-*，Chat.messages 里必须出现 type=reasoning 部件',
    async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const logDir = resolve(here, '../logs', stamp)
      mkdirSync(logDir, { recursive: true })

      const frozenSystem = loadAdminSystemPrompt()
      let sseText = ''

      const loggingFetch: typeof fetch = async (input, init) => {
        const response = await fetch(input, init)
        sseText = await response.text()
        writeFileSync(resolve(logDir, 'round-1-response.sse'), sseText)
        const rawBody = typeof init?.body === 'string' ? init.body : ''
        writeFileSync(resolve(logDir, 'round-1-request.json'), rawBody)
        return new Response(sseText, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }

      const chat = new Chat({
        api: API_URL,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
        },
        body: {
          model: MODEL,
          tools: TOOLS,
        },
        fetch: loggingFetch,
        adapter: {
          persistSession: true,
          prepareMessages: (messages) => {
            const system: UIMessage = {
              id: '__instructions',
              role: 'system',
              parts: [{ type: 'text', text: frozenSystem }],
            }
            return [system, ...messages.filter((m) => m.id !== '__instructions')]
          },
        },
      })

      await chat.sendMessage({ text: USER_TEXT })

      const types = chunkTypesOfSse(sseText)
      const chunks = parseSseChunks(sseText)
      const reduced = await reduceChunks(chunks)
      const assistant = chat.messages.find((m) => m.role === 'assistant')
      const chatReasoning = (assistant?.parts || []).filter((p) => p.type === 'reasoning')
      const reducedReasoning = reduced.parts.filter((p) => p.type === 'reasoning')

      const summary = {
        logDir,
        status: chat.status,
        error: chat.error?.message,
        sseChunkTypes: types,
        sseHasReasoningStart: types.includes('reasoning-start'),
        sseHasReasoningDelta: types.includes('reasoning-delta'),
        sseHasReasoningEnd: types.includes('reasoning-end'),
        chatPartTypes: assistant?.parts.map((p) => p.type) ?? [],
        chatReasoning: chatReasoning.map((p) => ({
          type: p.type,
          id: (p as { id?: string }).id,
          state: (p as { state?: string }).state,
          textLength: (p as { text?: string }).text?.length ?? 0,
          textPreview: ((p as { text?: string }).text || '').slice(0, 200),
        })),
        reducedPartTypes: reduced.parts.map((p) => p.type),
        reducedReasoning: reducedReasoning.map((p) => ({
          type: p.type,
          id: (p as { id?: string }).id,
          state: (p as { state?: string }).state,
          textLength: (p as { text?: string }).text?.length ?? 0,
          textPreview: ((p as { text?: string }).text || '').slice(0, 200),
        })),
      }
      writeFileSync(resolve(logDir, 'summary.json'), JSON.stringify(summary, null, 2))
      writeFileSync(
        resolve(logDir, 'chat-messages.json'),
        JSON.stringify(chat.messages, null, 2),
      )
      writeFileSync(resolve(logDir, 'reduced.json'), JSON.stringify(reduced, null, 2))

      expect(sseText.length, `后端没有返回 SSE，日志 ${logDir}`).toBeGreaterThan(0)
      expect(
        types.includes('reasoning-start'),
        `SSE 里没有 reasoning-start（实际 ${types.join(',')}），日志 ${logDir}`,
      ).toBe(true)
      expect(
        types.includes('reasoning-delta'),
        `SSE 里没有 reasoning-delta，日志 ${logDir}`,
      ).toBe(true)

      expect(
        reducedReasoning.length,
        `processUIMessageStream 没有产出 reasoning 部件（parts=${reduced.parts.map((p) => p.type).join(',')}），日志 ${logDir}`,
      ).toBeGreaterThan(0)
      expect((reducedReasoning[0] as { text: string }).text.length).toBeGreaterThan(0)
      expect(reducedReasoning[0]).toMatchObject({ type: 'reasoning', state: 'done' })

      expect(chat.status, `Chat 未 ready：${chat.error?.message || ''}，日志 ${logDir}`).toBe(
        'ready',
      )
      expect(
        chatReasoning.length,
        `Chat.messages 没有 reasoning 部件（parts=${(assistant?.parts || []).map((p) => p.type).join(',')}），日志 ${logDir}`,
      ).toBeGreaterThan(0)
      expect((chatReasoning[0] as { text: string }).text.length).toBeGreaterThan(0)
      expect(chatReasoning[0]).toMatchObject({ type: 'reasoning', state: 'done' })
    },
    180_000,
  )
})

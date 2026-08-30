/**
 * 对着本地 aidianshang-api（默认 localhost:9002）复现管理端「创意应用」配置助手回路。
 *
 * 不进默认 `pnpm test`。需要 test/.env 里的 CHAT_API_TOKEN（不要提交）。
 *
 *   pnpm test:app-form
 *
 * 每轮 HTTP 的请求体 / SSE 原文写到 test/logs/<stamp>/。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Chat } from '../../src/chat/chat'
import { lastAssistantMessageIsCompleteWithToolCalls } from '../../src/chat/last-assistant-message-is-complete-with-tool-calls'
import { getToolName, isToolUIPart, type UIMessage } from '../../src/types/message'

const here = dirname(fileURLToPath(import.meta.url))
const TOKEN = process.env.CHAT_API_TOKEN
const API_URL =
  process.env.CHAT_API_URL || 'http://localhost:9002/ai/chat/completions'
const MODEL = process.env.CHAT_MODEL || 'mimo-v2.5'

const suite = TOKEN ? describe : describe.skip

const USER_TEXT = `我想以这个提示词做一个app：Transform the subject from the reference image into a cute, quirky hand-drawn doodle illustration. Use a minimalist children’s storybook / fashion sketch aesthetic with loose, imperfect black ink lines, visible scribbly pencil strokes, subtle cross-hatching, and a charming handmade feel. Keep the character’s recognizable facial features, hairstyle, face shape, clothing, accessories, and overall identity from the reference while simplifying them into a cute illustrated character. Character design: - Oversized head and small simplified body - Simple dot-like eyes and tiny minimal mouth - Soft rounded facial features - Slight rosy pink blush on the cheeks - Messy, expressive hand-drawn hair with many loose sketch lines - Slightly exaggerated, playful proportions - Natural, relaxed pose with a whimsical fashion-illustration feel Art style: - Black-and-white pencil/ink doodle drawing - Rough, imperfect sketch lines rather than clean digital outlines - Dense scribbled hair and clothing details - Light hand-colored accents - Subtle watercolor/crayon-like coloring - Minimal shading - White or off-white clean background - Lots of negative space - Cute, innocent, playful, cozy aesthetic - Looks like an original handmade notebook/fashion doodle illustration Preserve the important details of the reference image while converting everything into this consistent doodle-art style. The final image should feel hand-sketched, slightly imperfect, adorable, expressive, and effortlessly stylish, not like polished vector art or 3D cartoon art.`

const AVAILABLE_MODELS = [
  { name: 'openai/gpt-image-2', label: 'GPT Image 2（openai/gpt-image-2）' },
  { name: 'google/nano-banana-2', label: 'Nano Banana 2（google/nano-banana-2）' },
  { name: 'bytedance/seedream-5-pro', label: 'Seedream 5 Pro（bytedance/seedream-5-pro）' },
  { name: 'bytedance/seedream-5-lite', label: 'Seedream 5 Lite（bytedance/seedream-5-lite）' },
]

const PARAM_OPTIONS = {
  aspectRatio: [
    { label: 'auto', value: 'auto' },
    { label: '1:1', value: '1:1' },
    { label: '16:9', value: '16:9' },
    { label: '9:16', value: '9:16' },
    { label: '4:3', value: '4:3' },
    { label: '3:4', value: '3:4' },
    { label: '3:2', value: '3:2' },
    { label: '2:3', value: '2:3' },
  ],
  resolution: [
    { label: '1K', value: '1K' },
    { label: '2K', value: '2K' },
    { label: '4K', value: '4K' },
  ],
  duration: [] as { label: string; value: string }[],
}

function emptyForm() {
  return {
    title: '',
    desc: '',
    output: 'image',
    prompt: '',
    promptLocked: false,
    surfaces: ['design-sidebar'],
    sortOrder: 0,
    isEnabled: true,
    lockModel: 'openai/gpt-image-2',
    modelLocked: false,
    aspectRatio: 'auto',
    aspectRatioLocked: false,
    resolution: '1K',
    resolutionLocked: false,
    duration: null as number | null,
    durationLocked: false,
    inputMode: 'bag',
    bagLabel: '參考素材',
    bagAccept: ['image'],
    bagMin: 1,
    bagMax: 1,
    bagPresetCount: 0,
    hasCover: false,
    slots: [
      {
        key: 'source',
        label: '參考素材',
        accept: ['image'],
        min: 1,
        max: 1,
        locked: false,
        presetCount: 0,
      },
    ],
  }
}

function snapshotOf(form: ReturnType<typeof emptyForm>) {
  return {
    ...form,
    availableModels: AVAILABLE_MODELS,
    paramOptions: PARAM_OPTIONS,
  }
}

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
          surfaces: { type: 'array', items: { type: 'string' } },
          sortOrder: { type: 'number' },
          isEnabled: { type: 'boolean' },
          lockModel: { type: 'string' },
          modelLocked: { type: 'boolean' },
          aspectRatio: { type: 'string' },
          aspectRatioLocked: { type: 'boolean' },
          resolution: { type: 'string' },
          resolutionLocked: { type: 'boolean' },
          duration: { anyOf: [{ type: 'number' }, { type: 'null' }] },
          durationLocked: { type: 'boolean' },
          inputMode: { type: 'string', enum: ['bag', 'slots'] },
          bagLabel: { type: 'string' },
          bagAccept: {
            type: 'array',
            items: { type: 'string', enum: ['image', 'video'] },
          },
          bagMin: { type: 'number' },
          bagMax: { type: 'number' },
          slots: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                key: { type: 'string' },
                label: { type: 'string' },
                accept: {
                  type: 'array',
                  items: { type: 'string', enum: ['image', 'video'] },
                },
                min: { type: 'number' },
                max: { type: 'number' },
                locked: { type: 'boolean' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    },
  },
]

function collectToolCalls(messages: UIMessage[]) {
  const calls: Array<{ name: string; state: string; input: unknown }> = []
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue
      calls.push({
        name: getToolName(part),
        state: part.state,
        input: (part as { input?: unknown }).input,
      })
    }
  }
  return calls
}

function assistantText(messages: UIMessage[]) {
  return messages
    .filter((m) => m.role === 'assistant')
    .flatMap((m) => m.parts)
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('')
    .trim()
}

suite('创意应用配置助手：本地 completions 回路', () => {
  it(
    '一次用户提交：get → apply → 收尾，正好 3 轮 HTTP',
    async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const logDir = resolve(here, '../logs', stamp)
      mkdirSync(logDir, { recursive: true })

      const form = emptyForm()
      const frozenSystem = loadAdminSystemPrompt()

      let round = 0
      const roundMeta: Array<{
        round: number
        toolNamesInHistory: string[]
      }> = []

      const loggingFetch: typeof fetch = async (input, init) => {
        round += 1
        const rawBody = typeof init?.body === 'string' ? init.body : ''
        let parsed: any
        try {
          parsed = JSON.parse(rawBody)
        } catch {
          parsed = rawBody
        }
        writeFileSync(
          resolve(logDir, `round-${round}-request.json`),
          JSON.stringify(parsed, null, 2),
        )
        const toolNamesInHistory = collectToolCalls(parsed?.messages || []).map(
          (c) => c.name,
        )
        roundMeta.push({
          round,
          toolNamesInHistory,
        })

        const response = await fetch(input, init)
        const text = await response.text()
        writeFileSync(resolve(logDir, `round-${round}-response.sse`), text)
        return new Response(text, {
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
              id: 'turn-instructions',
              role: 'system',
              parts: [{ type: 'text', text: frozenSystem }],
            }
            return [
              system,
              ...messages.filter((m) => m.id !== 'turn-instructions'),
            ]
          },
        },
        sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
        onToolCall: ({ toolCall }) => {
          let output: unknown
          if (toolCall.toolName === 'get_app_form') {
            output = snapshotOf(form)
          } else if (toolCall.toolName === 'apply_app_form') {
            const input = (toolCall.input || {}) as Record<string, unknown>
            for (const key in input) {
              if (key === 'slots' && Array.isArray(input.slots)) {
                form.slots = input.slots.map((s: any, index: number) => ({
                  key: String(s?.key || `slot${index + 1}`),
                  label: typeof s?.label === 'string' ? s.label : '參考素材',
                  accept: Array.isArray(s?.accept) ? s.accept : ['image'],
                  min: Number.isFinite(s?.min) ? Number(s.min) : 1,
                  max: Number.isFinite(s?.max) ? Number(s.max) : 1,
                  locked: !!s?.locked,
                  presetCount: 0,
                }))
                continue
              }
              ;(form as any)[key] = input[key]
            }
            output = snapshotOf(form)
          } else {
            output = { error: `未知工具 ${toolCall.toolName}` }
          }
          void chat.addToolOutput({
            toolCallId: toolCall.toolCallId,
            output,
          })
        },
      })

      await chat.sendMessage({ text: USER_TEXT })

      const calls = collectToolCalls(chat.messages)
      const getCount = calls.filter((c) => c.name === 'get_app_form').length
      const applyCount = calls.filter((c) => c.name === 'apply_app_form').length
      const text = assistantText(chat.messages)
      const summary = {
        logDir,
        httpRounds: round,
        status: chat.status,
        error: chat.error?.message,
        toolCalls: calls.map((c) => ({ name: c.name, state: c.state })),
        getCount,
        applyCount,
        assistantText: text,
        form: snapshotOf(form),
        roundMeta,
      }
      writeFileSync(
        resolve(logDir, 'summary.json'),
        JSON.stringify(summary, null, 2),
      )
      writeFileSync(
        resolve(logDir, 'messages.json'),
        JSON.stringify(chat.messages, null, 2),
      )

      expect(chat.status, `Chat 未 ready：${chat.error?.message || ''}`).toBe(
        'ready',
      )
      expect(
        calls.map((c) => c.name),
        `工具顺序不对，日志 ${logDir}`,
      ).toEqual(['get_app_form', 'apply_app_form'])
      expect(getCount, `get_app_form 应为 1 次，日志 ${logDir}`).toBe(1)
      expect(applyCount, `apply_app_form 应为 1 次，日志 ${logDir}`).toBe(1)
      expect(round, `应为 get → apply → 收尾共 3 轮，实际 ${round}，日志 ${logDir}`).toBe(3)
      expect(roundMeta[0]?.toolNamesInHistory).toEqual([])
      expect(roundMeta[1]?.toolNamesInHistory).toEqual(['get_app_form'])
      expect(roundMeta[2]?.toolNamesInHistory).toEqual([
        'get_app_form',
        'apply_app_form',
      ])
      expect(text.length, '第三轮缺少收尾中文').toBeGreaterThan(4)
      expect(form.title.trim().length, 'apply 后标题仍为空').toBeGreaterThan(0)
      expect(form.promptLocked).toBe(true)
    },
    180_000,
  )
})

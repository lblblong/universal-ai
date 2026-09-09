import { describe, expect, it, vi } from 'vitest'
import { processUIMessageStream, textOf, type UIMessageStreamState } from '../../src/stream/process-ui-message-stream'
import type { UIMessageChunk } from '../../src/types/chunk'
import type { UIMessage } from '../../src/types/message'

function makeState(): UIMessageStreamState<UIMessage> {
  return { message: { id: 'assistant-1', role: 'assistant', parts: [] } }
}

async function run(chunks: UIMessageChunk[], options: Parameters<typeof processUIMessageStream>[0]) {
  const source = new ReadableStream<UIMessageChunk>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
  const out: UIMessageChunk[] = []
  const processed = source.pipeThrough(processUIMessageStream(options))
  const reader = processed.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out.push(value)
  }
  return out
}

const baseTextChunks: UIMessageChunk[] = [
  { type: 'start', messageId: 'm1' },
  { type: 'start-step' },
  { type: 'text-start', id: 't1' },
  { type: 'text-delta', id: 't1', delta: '你好' },
  { type: 'text-delta', id: 't1', delta: '，世界' },
  { type: 'text-end', id: 't1' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
]

describe('processUIMessageStream', () => {
  it('文本流归约：text parts 累积并完结', async () => {
    const state = makeState()
    await run(baseTextChunks, { state })
    expect(state.message.id).toBe('m1')
    expect(textOf(state.message)).toBe('你好，世界')
    expect(state.message.parts.filter((p) => p.type === 'text')[0]).toMatchObject({ type: 'text', state: 'done' })
    expect(state.finishReason).toBe('stop')
  })

  it('text-delta 先于 text-start 时自动补开 part 不丢字', async () => {
    const state = makeState()
    await run(
      [
        { type: 'text-delta', id: 't1', delta: '孤' },
        { type: 'text-delta', id: 't1', delta: '勇者' },
      ],
      { state },
    )
    expect(textOf(state.message)).toBe('孤勇者')
  })

  it('step-start 产生部件边界', async () => {
    const state = makeState()
    await run(
      [
        { type: 'start-step' },
        { type: 'text-start', id: 'a' },
        { type: 'text-delta', id: 'a', delta: '第一段' },
        { type: 'text-end', id: 'a' },
        { type: 'finish-step' },
        { type: 'start-step' },
        { type: 'text-start', id: 'b' },
        { type: 'text-delta', id: 'b', delta: '第二段' },
        { type: 'text-end', id: 'b' },
        { type: 'finish-step' },
      ],
      { state },
    )
    expect(state.message.parts.filter((p) => p.type === 'step-start')).toHaveLength(2)
    expect(textOf(state.message)).toBe('第一段第二段')
  })

  it('工具输入流：input-streaming → input-available', async () => {
    const state = makeState()
    const onToolCall = vi.fn()
    await run(
      [
        { type: 'tool-input-start', toolCallId: 'call1', toolName: 'get_weather' },
        { type: 'tool-input-delta', toolCallId: 'call1', inputTextDelta: '{"city":' },
        { type: 'tool-input-delta', toolCallId: 'call1', inputTextDelta: '"北京"}' },
        { type: 'tool-input-available', toolCallId: 'call1', toolName: 'get_weather', input: { city: '北京' } },
      ],
      { state, onToolCall },
    )
    const part = state.message.parts[0] as any
    expect(part.state).toBe('input-available')
    expect(part.input).toEqual({ city: '北京' })
    // 静态工具：工具名编码在 type 中，不含 toolName 字段
    expect(part.type).toBe('tool-get_weather')
    expect(part.toolName).toBeUndefined()
    expect(onToolCall).toHaveBeenCalledWith({ toolCall: { toolCallId: 'call1', toolName: 'get_weather', input: { city: '北京' } } })
  })

  it('动态工具 chunk 产生 dynamic-tool 部件', async () => {
    const state = makeState()
    await run(
      [{ type: 'tool-input-available', toolCallId: 'c1', toolName: 'lookup', input: { q: 'x' }, dynamic: true }],
      { state },
    )
    const part = state.message.parts[0] as any
    expect(part.type).toBe('dynamic-tool')
    expect(part.toolName).toBe('lookup')
  })

  it('providerExecuted 的工具不触发 onToolCall', async () => {
    const state = makeState()
    const onToolCall = vi.fn()
    await run(
      [{ type: 'tool-input-available', toolCallId: 'c1', toolName: 'web', input: {}, providerExecuted: true }],
      { state, onToolCall },
    )
    expect(onToolCall).not.toHaveBeenCalled()
    expect((state.message.parts[0] as any).providerExecuted).toBe(true)
  })

  it('error chunk 抛出并中断流处理', async () => {
    const state = makeState()
    await expect(
      run([{ type: 'text-start', id: 't' }, { type: 'error', errorText: '渠道爆炸' }], { state }),
    ).rejects.toThrow('渠道爆炸')
  })

  it('未知 chunk 静默忽略并可观测', async () => {
    const state = makeState()
    const onUnknownChunk = vi.fn()
    const unknown = { type: 'source-url', sourceId: 's1', url: 'https://example.com' } as unknown as UIMessageChunk
    await run([...baseTextChunks.slice(0, 3), unknown, ...baseTextChunks.slice(3)], { state, onUnknownChunk })
    expect(textOf(state.message)).toBe('你好，世界')
    expect(onUnknownChunk).toHaveBeenCalledWith(unknown)
  })

  it('思考流归约：reasoning parts 累积并完结', async () => {
    const state = makeState()
    await run(
      [
        { type: 'start', messageId: 'm1' },
        { type: 'start-step' },
        { type: 'reasoning-start', id: 'reasoning-0' },
        { type: 'reasoning-delta', id: 'reasoning-0', delta: 'The user wants to' },
        { type: 'reasoning-delta', id: 'reasoning-0', delta: ' create an app' },
        { type: 'reasoning-end', id: 'reasoning-0' },
        { type: 'tool-input-start', toolCallId: 'call1', toolName: 'get_app_form' },
        { type: 'tool-input-available', toolCallId: 'call1', toolName: 'get_app_form', input: {} },
        { type: 'finish-step' },
        { type: 'finish', finishReason: 'tool-calls' },
      ],
      { state },
    )
    const reasoning = state.message.parts.filter((p) => p.type === 'reasoning')
    expect(reasoning).toHaveLength(1)
    expect(reasoning[0]).toMatchObject({
      type: 'reasoning',
      id: 'reasoning-0',
      text: 'The user wants to create an app',
      state: 'done',
    })
    expect(state.message.parts.map((p) => p.type)).toEqual(['step-start', 'reasoning', 'tool-get_app_form'])
  })

  it('多段思考各自独立累积', async () => {
    const state = makeState()
    await run(
      [
        { type: 'reasoning-start', id: 'reasoning-1' },
        { type: 'reasoning-delta', id: 'reasoning-1', delta: '先想' },
        { type: 'reasoning-end', id: 'reasoning-1' },
        { type: 'reasoning-start', id: 'reasoning-2' },
        { type: 'reasoning-delta', id: 'reasoning-2', delta: '再想' },
        { type: 'reasoning-end', id: 'reasoning-2' },
      ],
      { state },
    )
    const reasoning = state.message.parts.filter((p) => p.type === 'reasoning')
    expect(reasoning.map((p) => (p as { id?: string; text: string }).text)).toEqual(['先想', '再想'])
    expect(reasoning.map((p) => (p as { id?: string }).id)).toEqual(['reasoning-1', 'reasoning-2'])
  })

  it('reasoning-delta 先于 reasoning-start 时自动补开 part 不丢内容', async () => {
    const state = makeState()
    await run(
      [
        { type: 'reasoning-delta', id: 'reasoning-0', delta: '半截' },
        { type: 'reasoning-delta', id: 'reasoning-0', delta: '思考' },
        { type: 'reasoning-end', id: 'reasoning-0' },
      ],
      { state },
    )
    expect(state.message.parts[0]).toMatchObject({
      type: 'reasoning',
      id: 'reasoning-0',
      text: '半截思考',
      state: 'done',
    })
  })

  it('flush 时把悬挂的 streaming 思考收敛为 done', async () => {
    const state = makeState()
    await run(
      [
        { type: 'reasoning-start', id: 'reasoning-0' },
        { type: 'reasoning-delta', id: 'reasoning-0', delta: '还在想' },
        { type: 'finish' },
      ],
      { state },
    )
    expect(state.message.parts[0]).toMatchObject({ type: 'reasoning', text: '还在想', state: 'done' })
  })

  it('服务端工具输出 chunk 更新部件状态', async () => {
    const state = makeState()
    await run(
      [
        { type: 'tool-input-available', toolCallId: 'c1', toolName: 'web_search', input: { q: 'x' }, providerExecuted: true },
        { type: 'tool-output-available', toolCallId: 'c1', output: { hits: 3 } },
      ],
      { state },
    )
    expect(state.message.parts[0]).toMatchObject({ state: 'output-available', output: { hits: 3 } })
  })

  it('abort chunk 记录中断标记', async () => {
    const state = makeState()
    await run([{ type: 'start' }, { type: 'abort' }], { state })
    expect(state.aborted).toBe(true)
  })

  it('flush 时把悬挂的 streaming 文本收敛为 done', async () => {
    const state = makeState()
    // 没有 text-end，流直接结束
    await run(
      [
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: '半截' },
        { type: 'finish' },
      ],
      { state },
    )
    expect(state.message.parts[0]).toMatchObject({ type: 'text', text: '半截', state: 'done' })
  })
})

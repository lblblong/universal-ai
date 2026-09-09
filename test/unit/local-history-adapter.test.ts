import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalHistoryAdapter } from '../../src/adapter'
import type { UIMessage } from '../../src/types/message'

const waitFor = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 模拟 Vue reactive：递归代理嵌套对象/数组，模拟代理无法被结构化克隆的特性 */
function fakeReactive<T>(obj: T): T {
  if (obj === null || typeof obj !== 'object') return obj
  return new Proxy(obj, {
    get: (target, key) => {
      const v = Reflect.get(target, key)
      return typeof v === 'object' && v !== null ? fakeReactive(v as object) : v
    },
  }) as T
}

const msg = (id: string, text: string): UIMessage => ({
  id,
  role: 'user',
  parts: [{ type: 'text', text }],
})

describe('createLocalHistoryAdapter（持久化健壮性）', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('save 传入响应式代理数组：快照解开代理，load 返回可克隆的普通数据', async () => {
    const adapter = createLocalHistoryAdapter({ persist: 'memory' })
    const reactiveMessages = fakeReactive([msg('a', '你好')])
    adapter.save!(reactiveMessages)
    await waitFor(250)
    const loaded = await adapter.load!()
    expect(loaded).toEqual([msg('a', '你好')])
    // 关键断言：结果可被结构化克隆（Proxy 场景此前必然 DataCloneError）
    expect(() => structuredClone(loaded)).not.toThrow()
  })

  it('save 快照凝固在调用时刻：debounce 期间清空活数组不影响已保存内容', async () => {
    const adapter = createLocalHistoryAdapter({ persist: 'memory' })
    const liveMessages = [msg('a', '第一轮')]
    adapter.save!(liveMessages as UIMessage[])
    // 快照之后、flush 之前清空（切换会话的典型时序）
    liveMessages.length = 0
    await waitFor(250)
    expect(await adapter.load!()).toEqual([msg('a', '第一轮')])
  })

  it('save 传入不可克隆数据时大声报错且不抛异常（IndexedDB 路径）', async () => {
    const errorSpy = vi.mocked(console.error)
    // node 无 indexedDB：结构化克隆校验先于环境探测执行，数据缺陷仍会暴露
    const adapter = createLocalHistoryAdapter({
      persist: 'indexeddb',
      key: 'test:serialize-fail',
    })
    const bad: any = [msg('b', '含函数')]
    bad[0].parts.push({ type: 'text', text: 'x', fn: () => 'oops' })
    expect(() => adapter.save!(bad)).not.toThrow()
    await waitFor(250)

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('聊天历史序列化失败'),
      expect.any(Error),
    )
  })

  it('连续多次 save 只保留最后一次内容', async () => {
    const adapter = createLocalHistoryAdapter({ persist: 'memory' })
    adapter.save!([msg('a', '1')])
    adapter.save!([msg('a', '1'), msg('b', '2')])
    await waitFor(250)
    expect(await adapter.load!()).toHaveLength(2)
  })
})

describe('toPlainSnapshot（经 adapter 间接受益于响应式注入）', () => {
  it('IndexedDB 路径：代理数组经快照后可走完整 save/load 往返', async () => {
    // node 环境无 indexedDB，writeIndexedDb 的环境分支会静默跳过，
    // 这里退而验证 memory 模式下同一条快照管线（两者共用 save 实现）
    const adapter = createLocalHistoryAdapter({ persist: 'memory' })
    const reactiveMessages = fakeReactive([
      { id: 'a', role: 'user', parts: [{ type: 'text', text: 'hi' }], metadata: { deep: { ok: true } } },
      { id: 'b', role: 'assistant', parts: [{ type: 'file', url: 'data:image/png;base64,x', mediaType: 'image/png' }] },
    ])
    adapter.save!(reactiveMessages)
    await waitFor(250)
    const loaded = await adapter.load!()
    expect(loaded?.[0].parts[0]).toEqual({ type: 'text', text: 'hi' })
    expect(() => structuredClone(loaded)).not.toThrow()
  })
})

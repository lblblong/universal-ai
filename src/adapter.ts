import type { UIMessage } from './types/message'
import type { ChatSendTrigger } from './types/chat'
import { toPlainSnapshot } from './utils/plain-snapshot'

export type { ChatSendTrigger }

export type ChatAdapter<UI_MESSAGE extends UIMessage = UIMessage> = {
  /**
   * true：多次 submit 之间保留 Chat.messages（本地会话）。
   * false / 缺省：submit 时重建 state（WJI Conversation 用 onMessage 往外同步）。
   */
  persistSession?: boolean
  load?: () => Promise<UI_MESSAGE[] | undefined> | UI_MESSAGE[] | undefined
  save?: (messages: UI_MESSAGE[]) => Promise<void> | void
  prepareMessages?: (
    messages: UI_MESSAGE[],
    meta: { trigger: ChatSendTrigger; messageId?: string },
  ) => UI_MESSAGE[]
}

/**
 * WJI：会话历史在服务端，请求只带本轮（默认最后一条）。
 * tool 续跑时 Chat 内部会带上当前 round 的 tool-call / tool-result，
 * 若只有一条则原样发送，避免把 in-flight 的多 part 截断。
 */
export function createServerHistoryAdapter<
  UI_MESSAGE extends UIMessage = UIMessage,
>(opts: { send?: 'last' | 'all' } = {}): ChatAdapter<UI_MESSAGE> {
  const send = opts.send ?? 'last'

  return {
    persistSession: false,
    prepareMessages: (messages) => {
      if (send === 'all' || messages.length <= 1) return messages
      return messages.slice(-1)
    },
  }
}

export type LocalHistoryPersist = 'memory' | 'indexeddb'

/**
 * 本地会话：Chat 自己持有全量 messages，请求带完整历史。
 * persist=memory 只活在当前实例；indexeddb 按 key 读写，刷新可恢复。
 */
export function createLocalHistoryAdapter<
  UI_MESSAGE extends UIMessage = UIMessage,
>(opts: { persist?: LocalHistoryPersist; key?: string } = {}): ChatAdapter<UI_MESSAGE> {
  const persist = opts.persist ?? 'memory'
  const key = opts.key
  let memory: UI_MESSAGE[] | undefined
  let saveTimer: ReturnType<typeof setTimeout> | undefined

  if (persist === 'indexeddb' && !key) {
    throw new Error('createLocalHistoryAdapter: persist=indexeddb 时必须传 key')
  }

  const flushSave = (messages: UI_MESSAGE[]) => {
    memory = messages
    if (persist !== 'indexeddb' || !key) return
    void writeIndexedDb(key, messages)
  }

  return {
    persistSession: true,
    load: async () => {
      if (persist === 'indexeddb' && key) {
        memory = (await readIndexedDb<UI_MESSAGE[]>(key)) ?? []
        return memory
      }
      return memory
    },
    save: (messages) => {
      if (saveTimer) clearTimeout(saveTimer)
      // 调用时刻立即做快照：flush 是 200ms 后的宏任务，期间消费者可能清空 / 替换
      // 数组（切换会话），活引用会把彼时的内容写进本会话槽位造成串台；
      // toPlainSnapshot 同时解开响应式代理，否则 IndexedDB 结构化克隆会静默失败
      const snapshot = toPlainSnapshot(messages)
      saveTimer = setTimeout(() => flushSave(snapshot as UI_MESSAGE[]), 200)
    },
    prepareMessages: (messages) => messages,
  }
}

const IDB_NAME = 'universal-ai'
const IDB_STORE = 'chat-messages'

function openIndexedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const req = indexedDB.open(IDB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function readIndexedDb<T>(key: string): Promise<T | undefined> {
  try {
    const db = await openIndexedDb()
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => reject(req.error)
    })
  } catch {
    return undefined
  }
}

async function writeIndexedDb(key: string, value: unknown) {
  // 先独立做结构化克隆：数据不可克隆（函数 / class 实例等）是数据缺陷，
  // 必须暴露而非静默吞掉——否则表现为「历史悄悄丢失」，无从排查
  try {
    value = structuredClone(value)
  } catch (err) {
    console.error(`[universal-ai] 聊天历史序列化失败，本次保存已跳过（key: ${key}）`, err)
    return
  }

  try {
    const db = await openIndexedDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      const req = tx.objectStore(IDB_STORE).put(value, key)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  } catch {
    // 环境不可用（无痕模式 / SSR / 配额）：静默忽略，会话仍在内存
  }
}

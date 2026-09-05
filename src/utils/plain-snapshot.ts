/**
 * 递归重建为「可结构化克隆」的普通数据快照。
 *
 * 为什么需要：注入式用法（InjectedArrayState）允许消费者传入响应式数组，
 * Vue/MobX 等的代理对象无法被 IndexedDB 的结构化克隆处理（DataCloneError），
 * 且无法从代理本身可靠检测——只能在持久化边界重建普通容器。
 *
 * 规则：
 * - 普通对象 / 数组：新建容器逐项重建。读取代理属性拿到的即底层数据，
 *   重建过程天然解开任意层级的响应式代理，且不依赖任何框架
 * - Map / Set：重建为新的 Map / Set（覆盖 Vue 的集合代理）
 * - 其它值（原始值 / File / Blob / Date / RegExp / class 实例）：原样传递，
 *   它们不会被响应式系统包装，结构化克隆也原生支持
 * - undefined 值的键丢弃；循环引用丢弃该引用（消息结构本身不存在环）
 */
export function toPlainSnapshot<T>(value: T): T {
  return rebuild(value, new Map()) as T
}

function rebuild(value: unknown, seen: Map<unknown, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value

  if (value instanceof Map) {
    if (seen.has(value)) return undefined
    seen.set(value, true)
    const out = new Map()
    for (const [k, v] of value) out.set(rebuild(k, seen), rebuild(v, seen))
    return out
  }

  if (value instanceof Set) {
    if (seen.has(value)) return undefined
    seen.set(value, true)
    const out = new Set()
    for (const v of value) out.add(rebuild(v, seen))
    return out
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined
    seen.set(value, true)
    const out = new Array(value.length)
    for (let i = 0; i < value.length; i++) out[i] = rebuild(value[i], seen)
    return out
  }

  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return value

  if (seen.has(value)) return undefined
  seen.set(value, true)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value)) {
    const v = rebuild((value as Record<string, unknown>)[key], seen)
    if (v !== undefined) out[key] = v
  }
  return out
}

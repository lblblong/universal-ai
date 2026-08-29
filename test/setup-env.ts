import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 极简 .env 加载（零依赖，避免为测试引入 dotenv）：
 * 读取 test/.env 的 KEY=VALUE 写入 process.env，已存在的环境变量优先。
 */
const here = dirname(fileURLToPath(import.meta.url))
try {
  const raw = readFileSync(resolve(here, '.env'), 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
} catch {
  // test/.env 不存在时跳过（集成测试会因缺少 key 被 skip）
}

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup-env.ts'],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // 真实 API 集成测试较慢，串行跑避免触发渠道限流
    fileParallelism: false,
  },
})

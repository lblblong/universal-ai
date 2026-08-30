import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/probes/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['test/setup-env.ts'],
    testTimeout: 180_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
})

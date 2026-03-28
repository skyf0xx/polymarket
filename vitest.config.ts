import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['tests/**/*.test.ts'],
    reporters: ['verbose'],
    env: {
      NODE_ENV: 'test',
    },
  },
  resolve: {
    conditions: ['node'],
  },
})

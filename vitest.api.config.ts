import { defineConfig } from 'vitest/config';

/** 后端测试：node 环境 + 真实 LMDB 临时目录（docs/04-development/testing-strategy.md §4） */
export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['app/backend/test/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/api',
      reporter: ['text', 'json-summary'],
      thresholds: {
        statements: 70,
        branches: 60,
        functions: 70,
        lines: 70,
      },
    },
  },
  esbuild: {
    target: 'es2022',
  },
});

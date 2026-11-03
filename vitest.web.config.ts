import { defineConfig } from 'vitest/config';

/** 前端测试：jsdom 环境（docs/04-development/testing-strategy.md §2） */
export default defineConfig({
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['app/frontend/src/**/*.test.ts', 'app/frontend/src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage/web',
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

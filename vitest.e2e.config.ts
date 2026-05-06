import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['tests/e2e/**/*.test.ts'],
    sequence: {
      concurrent: false
    },
    testTimeout: 90000,
    hookTimeout: 30000,
    clearMocks: true,
    restoreMocks: true
  }
});

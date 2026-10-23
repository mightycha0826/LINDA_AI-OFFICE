import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    passWithNoTests: true,
    // 실제 git·자식 프로세스를 쓰는 테스트는 Windows(백신 검사)에서 5초를 넘기기 쉽다
    testTimeout: 60_000,
  },
});

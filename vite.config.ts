import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  build: { license: { fileName: 'third-party-licenses.md' } },
  test: { include: ['{src,tests}/**/*.test.ts'] },
});

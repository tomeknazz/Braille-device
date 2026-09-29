import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build works from GitHub Pages or any sub-path.
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});

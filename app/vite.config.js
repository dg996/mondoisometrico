import { defineConfig } from 'vite';

// base './' keeps dist/ portable (sub-path hosting and file:// inspection)
export default defineConfig({
  base: './',
  publicDir: false,
  build: { target: 'es2022', outDir: 'dist' },
});

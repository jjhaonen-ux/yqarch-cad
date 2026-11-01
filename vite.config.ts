import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), {
    name: 'copy-editor-assets',
    closeBundle() {
      const source = resolve(process.cwd(), 'assets');
      const target = resolve(process.cwd(), 'dist/assets');
      if (existsSync(source)) { mkdirSync(target, { recursive: true }); cpSync(source, target, { recursive: true }); }
    },
  }],
  publicDir: false,
  build: { outDir: 'dist', emptyOutDir: true },
});

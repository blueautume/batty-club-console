import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
export default defineConfig({ plugins: [vue()], server: { port: 5173, strictPort: true, watch: { ignored: ['**/data/**', '**/artifacts/**'] }, proxy: { '/api': process.env.BATTY_API_TARGET || 'http://127.0.0.1:4318' } }, build: { chunkSizeWarningLimit: 1400 } });

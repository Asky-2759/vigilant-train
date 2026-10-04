import { defineConfig } from 'vite';

const backendPort = process.env.PRONOUNCE_PORT || '8077';

export default defineConfig({
  server: {
    proxy: {
      '/api': `http://127.0.0.1:${backendPort}`,
    },
  },
});

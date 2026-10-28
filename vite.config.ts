import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
export default defineConfig({
  plugins: [
    react(),
    cloudflare({ persistState: { path: process.env.POSTBOX_LOCAL_STATE || '.postbox/local' } }),
  ],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
});

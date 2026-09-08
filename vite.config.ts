import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from 'vite-tsconfig-paths';

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:3001';

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tsconfigPaths(),
  ],
  server: {
    host: true,
    allowedHosts: ['.ngrok-free.dev'],
    proxy: {
      '/socket.io': {
        target: apiProxyTarget,
        ws: true,
      },
      '/api': {
        target: apiProxyTarget,
        changeOrigin: true,
        secure: false,
        configure: (proxy) => {
          proxy.on('error', (err) => {
            console.log('proxy error', err);
          });
          proxy.on('proxyReq', (proxyReq, req) => {
            console.log('Sending Request to the Target:', req.method, req.url);
          });
          proxy.on('proxyRes', (proxyRes, req) => {
            console.log('Received Response from the Target:', proxyRes.statusCode, req.url);
          });
        },
      }
    }
  }
})

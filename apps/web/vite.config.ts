import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Client-oriented build on purpose: the same bundle drops into Capacitor later
// without a server-rendering layer to unpick first.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'What a Pull',
        short_name: 'What a Pull',
        description: 'Pull something worth keeping.',
        theme_color: '#14120E',
        background_color: '#F4F1EA',
        display: 'standalone',
        start_url: '/',
        icons: [],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: '/index.html',
      },
    }),
  ],
  server: { port: 5173, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node',
    exclude: ['**/node_modules/**', '**/dist/**'],
    passWithNoTests: true,
  },
});

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // Le service worker se met à jour tout seul dès qu'une nouvelle version est déployée.
      registerType: 'autoUpdate',
      // Active le service worker en dev (`vite dev`) pour tester le Web Push sur localhost.
      devOptions: {
        enabled: true,
        type: 'module',
      },
      includeAssets: ['favicon.ico', 'apple-touch-icon-180x180.png', 'logo.svg'],
      manifest: {
        name: 'ShareMate — matériel partagé',
        short_name: 'ShareMate',
        description: 'Gestion collective de matériel partagé : réservations, usage et frais.',
        lang: 'fr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#1f6f54',
        background_color: '#f6f7f6',
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: 'maskable-icon-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Le shell applicatif est préchargé ; l'app démarre donc hors-ligne.
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        // Handlers Web Push (push + notificationclick) ajoutés au service worker généré.
        importScripts: ['push-sw.js'],
        // Les routes non-API retombent sur index.html (SPA).
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/uploads\//],
        runtimeCaching: [
          {
            // Lecture API : réseau d'abord, cache de secours quand hors-ligne.
            // Le motif est écrit en toutes lettres : ces fonctions sont sérialisées telles quelles
            // dans le service worker généré, où une constante déclarée ici n'existerait pas.
            urlPattern: ({ url, request }) =>
              url.pathname.startsWith('/api/') &&
              !/^\/api\/documents\/[^/]+\/content$/.test(url.pathname) &&
              request.method === 'GET',
            handler: 'NetworkFirst',
            options: {
              cacheName: 'sharemate-api',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 },
              cacheableResponse: { statuses: [200] },
            },
          },
          {
            // Justificatifs et contenus de documents : jamais conservés sur l'appareil. Leur
            // lecture dépend du cercle de l'équipement, contrôlé à chaque requête côté serveur ;
            // un cache les rendrait à un droit révoqué, et les laisserait lisibles après une
            // déconnexion. Depuis le bucket, la réponse est en outre une redirection signée dont
            // l'URL expire : la rejouer ne donnerait qu'un refus.
            urlPattern: ({ url }) =>
              url.pathname.startsWith('/uploads/') || /^\/api\/documents\/[^/]+\/content$/.test(url.pathname),
            handler: 'NetworkOnly',
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
  build: {
    outDir: 'dist',
  },
});

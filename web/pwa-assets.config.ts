import { defineConfig } from '@vite-pwa/assets-generator/config';

// Génère les icônes PWA à partir de public/logo.svg.
// Le logo a des coins arrondis + coins transparents : pour les variantes
// maskable/apple on aplatit sur un fond vert plein (padding 0), ce qui donne
// un carré vert plein masquable proprement par le launcher Android / iOS.
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  images: 'public/logo.svg',
  preset: {
    transparent: {
      sizes: [64, 192, 512],
      favicons: [[48, 'favicon.ico']],
    },
    maskable: {
      sizes: [512],
      padding: 0,
      resizeOptions: { background: '#1f6f54' },
    },
    apple: {
      sizes: [180],
      padding: 0,
      resizeOptions: { background: '#1f6f54' },
    },
  },
});

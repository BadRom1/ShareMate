import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Deux suites, deux environnements : le serveur en Node, le front en jsdom.
    projects: [
      {
        test: {
          name: 'server',
          include: ['server/src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'web',
          include: ['web/src/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['web/src/test/setup.ts'],
        },
      },
    ],
    // Les seuils restent ceux du cœur métier : le front n'a pas vocation à être couvert au
    // pourcentage, ses tests visent les chemins où une régression est silencieuse.
    coverage: {
      provider: 'v8',
      include: ['server/src/domain/**', 'server/src/application/**'],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 85,
      },
    },
  },
});

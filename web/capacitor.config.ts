import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.sharemate.mobile',
  appName: 'ShareMate',
  // Le front buildé par Vite ; `cap sync` copie ce dossier dans le projet natif.
  webDir: 'dist',
};

export default config;

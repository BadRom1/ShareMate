/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL du backend si le front est servi depuis une autre origine. Vide par défaut (même-origine). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

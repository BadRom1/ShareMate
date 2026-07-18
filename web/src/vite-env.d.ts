/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Base URL de l'API pour l'app native (ex. "https://sharemate.up.railway.app"). Vide en web (même-origine). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

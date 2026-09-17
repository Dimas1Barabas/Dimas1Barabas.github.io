/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Базовый URL API, например http://localhost:3000/api */
  readonly VITE_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

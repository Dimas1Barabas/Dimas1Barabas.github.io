/**
 * Конфиг S3-хранилища постеров (этап 29). В стенде живёт SeaweedFS
 * с S3-шлюзом SigV4 (docker-compose, seaweedfs/s3.json), но протокол
 * стандартный — клиенту minio (npm) движок безразличен.
 *
 * S3_ENDPOINT — гейт всего модуля: переменной нет — стор не строится,
 * витрина живёт на градиентных фолбэках, загрузка отвечает 503.
 * Так стенды без хранилища (юнит-прогоны, демо-Pages) не падают.
 */
export interface PostersConfig {
  /** http://seaweedfs:8333 — scheme://host:port шлюза */
  endpoint: string;
  accessKey: string;
  secretKey: string;
  bucket: string;
}

export function postersConfigFromEnv(): PostersConfig | null {
  const endpoint = process.env.S3_ENDPOINT?.trim();
  if (!endpoint) return null;
  return {
    endpoint,
    accessKey: process.env.S3_ACCESS_KEY ?? '',
    secretKey: process.env.S3_SECRET_KEY ?? '',
    bucket: process.env.S3_BUCKET ?? 'cine-posters',
  };
}

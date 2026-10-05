import { initTracing } from './tracing';

// Побочный эффект при импорте: OTel-SDK должен стартовать до загрузки
// Nest/express (первой строкой в main.ts после reflect-metadata)
initTracing();

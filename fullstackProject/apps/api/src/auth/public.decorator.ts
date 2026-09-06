import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/** помечает эндпоинт, доступный без JWT (витрина: фильмы, залы, health, SSE) */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

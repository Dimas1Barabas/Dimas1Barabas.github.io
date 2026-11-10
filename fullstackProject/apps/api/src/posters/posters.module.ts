import { Module } from '@nestjs/common';
import { postersConfigFromEnv } from './posters.config';
import { PostersService } from './posters.service';
import { PostersStore } from './posters.store';

/**
 * S3-постеры фильмов (этап 29). Стор строится из env на сборке модуля:
 * S3_ENDPOINT есть — живой SigV4-клиент (в стенде — SeaweedFS), нет —
 * null-стор: витрина на градиентных фолбэках, загрузка 503, стенд
 * не падает. Контракт движка — стандартный S3, смена backend'а
 * переменной окружения.
 */
@Module({
  providers: [
    {
      provide: PostersStore,
      useFactory: () => {
        const config = postersConfigFromEnv();
        return config ? new PostersStore(config) : null;
      },
    },
    PostersService,
  ],
  exports: [PostersService],
})
export class PostersModule {}

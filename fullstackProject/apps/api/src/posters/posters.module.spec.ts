import { Test } from '@nestjs/testing';
import { PostersModule } from './posters.module';
import { PostersService } from './posters.service';

/**
 * Сборка модуля как в боевом app.module (в фейк-интеграциях MoviesModule
 * не грузится — а в реальных стендах крашился бут). Без S3_ENDPOINT
 * модуль обязан собираться: null-стор, сервис деградирует.
 */
describe('PostersModule (сборка модуля)', () => {
  it('без S3_ENDPOINT собирается: null-стор, сервис деградирует', async () => {
    const prev = process.env.S3_ENDPOINT;
    delete process.env.S3_ENDPOINT;
    try {
      const ref = await Test.createTestingModule({
        imports: [PostersModule],
      }).compile();
      const svc = ref.get(PostersService);
      expect(svc.enabled).toBe(false);
      await expect(svc.poster('movie-any')).resolves.toBeNull();
      await ref.close();
    } finally {
      if (prev !== undefined) process.env.S3_ENDPOINT = prev;
    }
  });

  it('с S3_ENDPOINT собирается без похода в сеть (клиент ленивый)', async () => {
    const prev = process.env.S3_ENDPOINT;
    process.env.S3_ENDPOINT = 'http://seaweedfs:8333';
    try {
      const ref = await Test.createTestingModule({
        imports: [PostersModule],
      }).compile();
      const svc = ref.get(PostersService);
      expect(svc.enabled).toBe(true);
      // бакет не создаётся на буте: недоступный стенд — деградация
      // на первом запросе, а не краш старта
      await ref.close();
    } finally {
      if (prev !== undefined) process.env.S3_ENDPOINT = prev;
      else delete process.env.S3_ENDPOINT;
    }
  });
});

import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Movie } from '../movies/movie.entity';
import { SearchModule } from './search.module';
import { SearchService } from './search.service';

/**
 * Сборка модуля как в боевом app.module: в реальных стендах модуль
 * грузится всегда, краш сбора роняет бут приложения (урок posters).
 * Без MEILI_HOST модуль обязан собираться: null-стор, поиск деградирует.
 */
describe('SearchModule (сборка модуля)', () => {
  const repoToken = getRepositoryToken(Movie);

  it('без MEILI_HOST собирается: null-стор, поиск деградирует', async () => {
    const prev = process.env.MEILI_HOST;
    delete process.env.MEILI_HOST;
    try {
      const ref = await Test.createTestingModule({
        imports: [SearchModule],
      })
        .overrideProvider(repoToken)
        .useValue({})
        .compile();
      const svc = ref.get(SearchService);
      expect(svc.enabled).toBe(false);
      await ref.close();
    } finally {
      if (prev !== undefined) process.env.MEILI_HOST = prev;
    }
  });

  it('с MEILI_HOST собирается без похода в сеть (клиент ленивый)', async () => {
    const prev = process.env.MEILI_HOST;
    process.env.MEILI_HOST = 'http://meilisearch:7700';
    try {
      const ref = await Test.createTestingModule({
        imports: [SearchModule],
      })
        .overrideProvider(repoToken)
        .useValue({})
        .compile();
      expect(ref.get(SearchService).enabled).toBe(true);
      await ref.close();
    } finally {
      if (prev !== undefined) process.env.MEILI_HOST = prev;
      else delete process.env.MEILI_HOST;
    }
  });
});

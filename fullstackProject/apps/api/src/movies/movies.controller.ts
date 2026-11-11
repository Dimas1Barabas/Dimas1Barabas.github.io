import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
  StreamableFile,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { Public } from '../auth/public.decorator';
import { Roles } from '../auth/roles.decorator';
import { PostersService } from '../posters/posters.service';
import { MovieDto } from './movie.entity';
import { CreateMovieDto } from './dto/create-movie.dto';
import { MoviesService } from './movies.service';

/** постер: формат-белый-список и потолок размера (в байтах) */
const POSTER_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const POSTER_MAX_BYTES = 2 * 1024 * 1024;
/** жёсткий предел multer чуть выше продуктового: до него отсекает
 *  контроллер честным 413, сверх — транспорт multipart'а */
const MULTER_HARD_LIMIT_BYTES = 4 * 1024 * 1024;

@ApiTags('movies')
@Controller('movies')
export class MoviesController {
  constructor(
    private readonly movies: MoviesService,
    private readonly posters: PostersService,
  ) {}

  /** витрина: каталог доступен без авторизации */
  @Public()
  @Get()
  @ApiOperation({
    summary: 'Каталог фильмов с расписанием',
    description:
      'Афиша, отсортированная по ближайшему будущему сеансу. Ответ-обёртка: ' +
      '`{ source: "cache" | "db", data: MovieDto[] }` — источник виден во ' +
      'фронте бейджем «из кэша» (Redis, TTL 60 c).',
  })
  @ApiOkResponse({ description: 'Каталог с сеансами и рейтингами' })
  findAll() {
    return this.movies.findAll();
  }

  @Public()
  @Get(':id')
  @ApiOperation({ summary: 'Фильм по id' })
  @ApiOkResponse({ type: MovieDto })
  @ApiNotFoundResponse({ description: 'Фильм не найден' })
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.movies.findOne(id);
  }

  /** новый сеанс — только администратору */
  @Roles('admin')
  @Post()
  @HttpCode(201)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Добавить фильм в афишу',
    description: 'Только админ (роль из JWT). Фильм создаётся сразу с сеансами.',
  })
  @ApiCreatedResponse({ type: MovieDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Роль не admin' })
  create(@Body() dto: CreateMovieDto) {
    return this.movies.create(dto);
  }

  /** витрина: постер из S3-бакета. Нет постера или хранилище молчит —
   *  404: фронт показывает градиентный фолбэк (деградация, не сбой).
   *  Кэш браузера — 5 минут + ETag: повторные заходы ревалидируются
   *  и получают 304 без байтов */
  @Public()
  @Get(':id/poster')
  @ApiOperation({
    summary: 'Постер фильма',
    description:
      'Объект S3 по ключу posters/<id> (Content-Type сохранён при загрузке). ' +
      'Заголовки кэша: `Cache-Control: public, max-age=300` + `ETag`; повторный ' +
      'запрос с `If-None-Match` — 304. Постера нет или хранилище недоступно — ' +
      '404: витрина уходит на градиентный фолбэк.',
  })
  @ApiOkResponse({
    description: 'Байты изображения',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiNotFoundResponse({
    description: 'Постера нет (или S3 молчит) — витрина на градиентном фолбэке',
  })
  async poster(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | undefined> {
    const poster = await this.posters.poster(id);
    if (!poster) {
      throw new NotFoundException('постера нет — витрина на градиентном фолбэке');
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('ETag', poster.etag);
    if (req.headers['if-none-match'] === poster.etag) {
      res.status(HttpStatus.NOT_MODIFIED); // ревалидация: байты не нужны
      return;
    }
    return new StreamableFile(poster.buffer, { type: poster.contentType });
  }

  /** постер — только администратору: multipart-поле poster,
   *  JPEG/PNG/WebP до 2 МБ; upsert по id фильма */
  @Roles('admin')
  @Post(':id/poster')
  @UseInterceptors(
    FileInterceptor('poster', {
      limits: { fileSize: MULTER_HARD_LIMIT_BYTES, files: 1 },
      fileFilter: (_req, file, cb) => {
        if (POSTER_TYPES.includes(file.mimetype)) cb(null, true);
        else
          cb(
            new UnsupportedMediaTypeException('постер: JPEG, PNG или WebP'),
            false,
          );
      },
    }),
  )
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { poster: { type: 'string', format: 'binary' } },
    },
  })
  @ApiOperation({
    summary: 'Загрузить/заменить постер фильма',
    description:
      'Только админ (роль из JWT). Multipart-поле `poster`: JPEG, PNG или ' +
      'WebP, до 2 МБ. Файл уходит в бакет под ключом posters/<id> — ' +
      'перезагрузка заменяет постер, URL стабилен. Хранилище молчит — 503.',
  })
  @ApiOkResponse({ description: 'Ключ и размер: { key, size }' })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Роль не admin' })
  @ApiNotFoundResponse({ description: 'Фильма нет' })
  async uploadPoster(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file?: Express.Multer.File,
  ) {
    await this.movies.findOne(id); // 404 до похода в S3
    if (!file) throw new BadRequestException('поле multipart «poster» обязательно');
    if (file.size > POSTER_MAX_BYTES) {
      throw new PayloadTooLargeException('постер: не больше 2 МБ');
    }
    return this.posters.upload(id, file.buffer, file.mimetype);
  }

  /** снятие постера (админ): витрина возвращается к градиенту;
   *  идемпотентен — удаления несуществующего не ошибка */
  @Roles('admin')
  @Delete(':id/poster')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiNoContentResponse({ description: 'Постера больше нет (или и не было)' })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Роль не admin' })
  @ApiNotFoundResponse({ description: 'Фильма нет' })
  @ApiOperation({
    summary: 'Удалить постер фильма',
    description: 'Идемпотентно: несуществующий постер — тоже 204.',
  })
  async deletePoster(@Param('id', ParseUUIDPipe) id: string) {
    await this.movies.findOne(id); // 404 если фильма нет
    await this.posters.remove(id);
  }
}

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthUser } from '../auth/auth-user';
import { Public } from '../auth/public.decorator';
import { ReviewDto } from './review.entity';
import { CreateReviewDto } from './dto/create-review.dto';
import { ReviewsService } from './reviews.service';

@ApiTags('reviews')
@Controller('movies/:movieId/reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** отзывы публичны — как и сам каталог */
  @Public()
  @Get()
  @ApiOperation({ summary: 'Отзывы фильма', description: 'Свежие сверху' })
  @ApiOkResponse({ type: [ReviewDto] })
  list(@Param('movieId', ParseUUIDPipe) movieId: string) {
    return this.reviews.listForMovie(movieId);
  }

  /** написать отзыв может только авторизованный с подтверждённой бронью */
  @Post()
  @HttpCode(201)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Написать отзыв',
    description:
      'Право на отзыв — текущая CONFIRMED-бронь на этот фильм (вернул ' +
      'билеты — права нет). Один отзыв на пару (пользователь, фильм): ' +
      'арбитр дубля — составной unique, гонка даёт 409 reviewExists. ' +
      'Агрегаты рейтинга на фильме пересчитываются той же транзакцией.',
  })
  @ApiCreatedResponse({ type: ReviewDto })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Нет подтверждённой брони на фильм' })
  @ApiConflictResponse({ description: 'Отзыв уже написан — код reviewExists' })
  create(
    @Param('movieId', ParseUUIDPipe) movieId: string,
    @Body() dto: CreateReviewDto,
    @Req() req: { user: AuthUser },
  ) {
    return this.reviews.create(movieId, dto, req.user);
  }

  /** удалить — свой отзыв или админ */
  @Delete(':id')
  @HttpCode(204)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Удалить отзыв', description: 'Свой отзыв или админ; поиск скоуплен по фильму' })
  @ApiNoContentResponse({ description: 'Удалён' })
  @ApiUnauthorizedResponse({ description: 'Нет JWT' })
  @ApiForbiddenResponse({ description: 'Чужой отзыв не админу' })
  @ApiNotFoundResponse({ description: 'Отзыв не найден' })
  remove(
    @Param('movieId', ParseUUIDPipe) movieId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: AuthUser },
  ) {
    return this.reviews.remove(movieId, id, req.user);
  }
}

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
import { AuthUser } from '../auth/auth-user';
import { Public } from '../auth/public.decorator';
import { CreateReviewDto } from './dto/create-review.dto';
import { ReviewsService } from './reviews.service';

@Controller('movies/:movieId/reviews')
export class ReviewsController {
  constructor(private readonly reviews: ReviewsService) {}

  /** отзывы публичны — как и сам каталог */
  @Public()
  @Get()
  list(@Param('movieId', ParseUUIDPipe) movieId: string) {
    return this.reviews.listForMovie(movieId);
  }

  /** написать отзыв может только авторизованный с подтверждённой бронью */
  @Post()
  @HttpCode(201)
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
  remove(
    @Param('movieId', ParseUUIDPipe) movieId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: { user: AuthUser },
  ) {
    return this.reviews.remove(movieId, id, req.user);
  }
}

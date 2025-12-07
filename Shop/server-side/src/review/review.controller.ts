import {
	Body,
	Controller,
	Get,
	HttpCode,
	Param,
	Post,
	UsePipes,
	ValidationPipe,
	CurrentUser, Delete
} from '@nestjs/common'
import { ReviewService } from './review.service'
import { Auth } from '../auth/decorators/auth.decorator'
import { ProductDto } from '../product/dto/product.dto'
import { ReviewDto } from './dto/review.dto'

@Controller('reviews')
export class ReviewController {
	constructor(private readonly reviewService: ReviewService) {}

	@Auth()
	@Get('by-storeId/:storeId')
	async getByStoreId(@Param('storeId') storeId: string) {
		return this.reviewService.getByStoreId(storeId)
	}

	@UsePipes(new ValidationPipe())
	@HttpCode(200)
	@Auth()
	@Post(':productId/:storeId')
	async create(
		@CurrentUser('id') userId: string,
		@Param('storeId') storeId: string,
		@Param('productId') productId: string,
		@Body() dto: ReviewDto
	) {
		return this.reviewService.create(userId, storeId, productId, dto)
	}
	
	@HttpCode(200)
	@Auth()
	@Delete(':id')
	async delete(@Param('id') id: string, @CurrentUser('id') userId: string) {
		return this.reviewService.delete(id, userId)
	}
}

import {
	Body,
	Controller,
	Delete,
	Get,
	HttpCode,
	Param,
	Post,
	Put,
	UsePipes,
	ValidationPipe
} from '@nestjs/common'
import { categoryService } from './category.service'
import { Auth } from '../auth/decorators/auth.decorator'
import { CreateStoreDto } from '../store/dto/create-store.dto'
import { UpdateStoreDto } from '../store/dto/update-store.dto'
import { categoryDto } from './dto/category.dto'

@Controller('category')
export class categoryController {
	constructor(private readonly categoryService: categoryService) {}
	
	@Auth()
	@Get('by-storeId/:storeId')
	async getByStoreId(@Param('storeId') storeId: string) {
		return this.categoryService.getByStoreId(storeId)
	}
	
	@Auth()
	@Get('by-id/:id')
	async getById(@Param('id') id: string) {
		return this.categoryService.getById(id)
	}
	
	@UsePipes(new ValidationPipe())
	@HttpCode(200)
	@Auth()
	@Post(':storeId')
	async create(@Param('storeId') id: string, @Body() dto: categoryDto) {
		return this.categoryService.create(id, dto)
	}
	
	@UsePipes(new ValidationPipe())
	@HttpCode(200)
	@Auth()
	@Put(':id')
	async update(@Param('id') id: string, @Body() dto: categoryDto) {
		return this.categoryService.update(id, dto)
	}
	
	@HttpCode(200)
	@Auth()
	@Delete(':id')
	async delete(@Param('id') id: string) {
		return this.categoryService.delete(id)
	}
}

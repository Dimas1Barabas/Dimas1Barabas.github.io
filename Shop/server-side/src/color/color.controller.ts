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
import { ColorService } from './color.service'
import { Auth } from '../auth/decorators/auth.decorator'
import { CreateStoreDto } from '../store/dto/create-store.dto'
import { UpdateStoreDto } from '../store/dto/update-store.dto'
import { ColorDto } from './dto/color.dto'

@Controller('color')
export class ColorController {
	constructor(private readonly colorService: ColorService) {}

	@Auth()
	@Get('by-storeId/:storeId')
	async getByStoreId(@Param('storeId') storeId: string) {
		return this.colorService.getByStoreId(storeId)
	}

	@Auth()
	@Get('by-id/:id')
	async getById(@Param('id') id: string) {
		return this.colorService.getById(id)
	}

	@UsePipes(new ValidationPipe())
	@HttpCode(200)
	@Auth()
	@Post(':storeId')
	async create(@Param('storeId') id: string, @Body() dto: ColorDto) {
		return this.colorService.create(id, dto)
	}

	@UsePipes(new ValidationPipe())
	@HttpCode(200)
	@Auth()
	@Put(':id')
	async update(@Param('id') id: string, @Body() dto: ColorDto) {
		return this.colorService.update(id, dto)
	}

	@HttpCode(200)
	@Auth()
	@Delete(':id')
	async delete(@Param('id') id: string) {
		return this.colorService.delete(id)
	}
}

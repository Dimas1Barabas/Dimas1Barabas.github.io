import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma.service'
import { CreateStoreDto } from '../store/dto/create-store.dto'
import { UpdateStoreDto } from '../store/dto/update-store.dto'
import { CategoryDto } from './dto/Category.dto'

@Injectable()
export class CategoryService {
	constructor(private prisma: PrismaService) {}
	
	async getByStoreId(stroreId: string) {
		return this.prisma.category.findMany({
			where: {
				stroreId
			}
		})
	}
	
	async getById(id: string) {
		const category = await this.prisma.Category.findUnique({
			where: {
				id
			}
		})
		
		if (!category) {
			throw new NotFoundException(`Категория не найдена`)
		}
		
		return category
	}
	
	async create(storeId: string, dto : CategoryDto) {
		return this.prisma.Category.create({
			data: {
				title: dto.title,
				description: dto.description,
				storeId
			}
		})
	}
	
	async update(id: string, dto: CategoryDto) {
		await this.getById(id)
		
		return this.prisma.Category.update({
			where: {
				id
			},
			data: dto
		})
	}
	
	async delete(id: string) {
		await this.getById(id)
		
		return this.prisma.Category.delete({
			where: {
				id
			}
		})
	}
}

import { Injectable } from '@nestjs/common'
import { PrismaService } from '../prisma.service'
import { CreateStoreDto } from './dto/create-store.dto'
import { UpdateStoreDto } from './dto/update-store.dto'

@Injectable()
export class StoreService {
	constructor(private prisma: PrismaService) {}
	
	async getById(storeId: string, userId: string) {
		const store = await this.prisma.store.findUnique({
			where: {
				id: storeId,
				userId
			}
		})
		
		if(!store) {
			throw new NotFoundException(
				`Магазин не найден или вы не являетесь его владельцем`
			)
		}
		
		return store
	}
	
	async create(userId: string, dto : CreateStoreDto) {
		return this.prisma.store.create({
			data: {
				title: dto.title,
				userId
			}
		})
	}
	
	async update(storedId: string, userId: string, dto: UpdateStoreDto) {
		await this.getById(storedId, userId)
		
		return this.prisma.store.update({
			where: {
				id: storedId
			},
			data: {
				...dto,
				userId
			}
		})
	}
	
	async delete(storedId: string, userId: string) {
		await this.getById(storedId, userId)
		
		return this.prisma.store.delete({
			where: {
				id: storedId
			}
		})
	}
}

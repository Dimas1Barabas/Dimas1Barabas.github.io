import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service'

@Injectable()
export class ProductService {
	constructor(private prisma: PrismaService) {}
	
	async getAll(searchTerm?: string) {
		if(searchTerm) return this.getSearchTermFilter(searchTerm)
		
		const products = await this.prisma.product.findMany({
			orderBy: {
				createdAt: 'desc'
			},
			include: {
				category: true,
				color: true,
				reviews: true
			}
		})
		
		return products
	}
	
	private getSearchTermFilter(searchTerm: string) {
		return {
			OR: [
				{
					title: {
						contains: searchTerm,
						mode: 'insensitive'
					},
					description: {
						contains: searchTerm,
						mode: 'insensitive'
					}
				}
			]
		}
	}
	
	async getByStoreId(stroreId: string) {
		return this.prisma.product.findMany({
			where: {
				stroreId
			},
			include: {
				category: true,
				color: true
			}
		})
	}
	
	async getById(id: string) {
		const product = await this.prisma.product.findUnique({
			where: {
				id
			},
			include: {
				category: true,
				color: true,
				reviews: true
			}
		})
		
		if (!product) {
			throw new NotFoundException(`Товар не найден`)
		}
		
		return product
	}
	
	async getByCategory(categoryId: string) {
		const products = await this.prisma.product.findMany({
			where: {
				category: {
					id: categoryId
				}
			},
			include: {
				category: true,
				color: true,
				reviews: true
			}
		})
		
		if (!products) {
			throw new NotFoundException(`Товары не найдены`)
		}
		
		return products
	}
	
	async getMostPopular() {
		const getMostPopularProducts = await this.prisma.orderItem.groupBy({
			by: ['productId'],
			_count: {
				id: true
			},
			orderBy: {
				_count: {
					id: 'desc'
				}
			}
		})
		
		const productIds = getMostPopularProducts.map(item => item.productId)
		
		const products = await this.prisma.product.findMany({
			where: {
				id: {
					in: productIds
				}
			},
			include: {
				category: true,
			}
		})
		
		return products
	}
}
//TODO 1 57 48
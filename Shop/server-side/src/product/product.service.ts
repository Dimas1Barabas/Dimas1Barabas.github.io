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
					}
				}
			]
		}
	}
}

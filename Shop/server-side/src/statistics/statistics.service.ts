import { Injectable } from '@nestjs/common'

import * as dayjs from 'dayjs'
import 'dayjs/locale/ru'
import { PrismaService } from '../prisma.service'

dayjs.locale('ru')

const monthNames = [
	'Январь',
	'Февраль',
	'Март',
	'Апрель',
	'Май',
	'Июнь',
	'Июль',
	'Август',
	'Сентябрь',
	'Октябрь',
	'Ноябрь',
	'Декабрь'
]

@Injectable()
export class StatisticsService {
	constructor(private prisma: PrismaService) {}

	async getMainStatictics(storeId: string) {
		const totalRevenue = await this.calculateTotalRevenue(storeId)

		const productsCount = await this.countProducts(storeId)
		const categoriesCount = await this.countCategories(storeId)

		const averageRating = await this.calculateAverageRating(storeId)

		return [
			{ id: 1, name: 'Выручка', value: totalRevenue },
			{ id: 2, name: 'Товары', value: productsCount },
			{ id: 3, name: 'Категори', value: categoriesCount },
			{ id: 4, name: 'Средний рейтинг', value: averageRating || 0 }
		]
	}

	async getMiddleStatictics(storeId: string) {
		const monthlySales = await this.calculateMonthlySales(storeId)

		const lastUsers = await this.getLastUsers(storeId)

		return { monthlySales, lastUsers }
	}
	
	private async calculateTotalRevenue(storeId: string) {
		const orders = await this.prisma.order.findMany({
			where: {
				items: {
					some: {
						store: { id: storeId }
					}
				}
			},
			includes: {
				items: {
					where: { storeId }
				}
			}
		})
		
		const totalRevenue = orders.reduce((acc, order) => {
			const total = order.items.reduce((itemAcc, item) => {
				return itemAcc + item.price * item.quantity
			}, 0)
			return acc + total
		})
		
		return totalRevenue
	}
	
	private async countProducts(storeId: string) {
		const productsCount = await this.prisma.product.count({
			where: { storeId }
		})
		return productsCount
	}
	
	private async countCategories(storeId: string) {
		const categoriesCount = await this.prisma.category.count({
			where: { storeId }
		})
		return categoriesCount
	}
	
	private async calculateAverageRating(storeId: string) {
		const averageRating = await this.prisma.review.aggregate({
			where: { storeId },
			_avg: { rating: true }
		})
		return averageRating._avg.rating
	}
	
	//TODO 2 37 55
}

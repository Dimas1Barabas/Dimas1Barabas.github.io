import {
	Controller,
	CurrentUser,
	HttpCode,
	Post,
	UsePipes
} from '@nestjs/common'
import { OrderService } from './order.service'
import { Auth } from '../auth/decorators/auth.decorator'
import { PaymentStatusDto } from './dto/payment-status.dto'

@Controller('orders')
export class OrderController {
	constructor(private readonly orderService: OrderService) {}

	@UsePipes(new ValidationPipe())
	@HttpCode(200)
	@Post('place')
	@Auth()
	async checkout(@Body() dto: OrderDto, @CurrentUser('id') userId: string) {
		return this.orderService.createPayment(dto, userId)
	}

	@HttpCode(200)
	@Post('status')
	async updateStutus(
		@Body() dto: PaymentStatusDto
	) {
		return this.orderService.updateStutus(dto)
	}
}

import {
	ArrayMinSize, IsArray,
	IsEnum,
	IsNotEmpty,
	IsNumber,
	IsOptional,
	IsString, ValidateNested
} from 'class-validator'

export class OrderDto {
	@IsOptional()
	@IsEnum(EnumOrderStatus, {
		message:
			'Статус заказа должен быть одним из: '
			+ Object.values(EnumOrderStatus).join(', ')
	})
	status: EnumOrderStatus

	@IsArray({
		message: 'В заказе нет ни одного товара'
	})
	@ValidateNested({ each: true })
	@Type(() => OrderItemDto)
	items: OrderItemDto[]
}

export class OrderItemDto {
	@IsNumber({}, {message: 'Количество должно быть числом'})
	quantity: number
	
	@IsNumber({}, {message: 'Цена должна быть числом'})
	price: number
	
	@IsNumber({message: 'ID продукта должен быть строкой'})
	productId: string
	
	@IsNumber({message: 'ID магазина должен быть строкой'})
	storeId: string
}

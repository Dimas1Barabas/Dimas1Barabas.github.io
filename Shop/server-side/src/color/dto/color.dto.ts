import { IsString } from 'class-validator'

export class ColorDto {
	@IsString({
		message: 'Название обязательно'
	})
	name: string
	
	@IsString({
		message: 'Значение не обязательно'
	})
	value: string
}
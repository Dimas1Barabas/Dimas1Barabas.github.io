import { ICategory } from "./category.interface"
import {IReview} from '@/shared/types/review.interface';
import {IColor} from '@/shared/types/color.interface';

export interface IProduct {
  id: string
  title: string
  description: string
  price: number
  images: string[]
  category: ICategory
  reviews: IReview[]
  color: IColor
  storeId: string
}

export interface IProductInput extends Omit<IProduct, 'id' | 'reviews' | 'storeId' | 'category' | 'color'> {
  categoryId: string
  colorId: string
}
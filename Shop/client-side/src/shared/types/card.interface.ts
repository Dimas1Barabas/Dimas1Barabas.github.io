import {IProduct} from '@/shared/types/product.interface';

export interface ICardItem {
  id: number
  product: IProduct
  quantity: number
  price: number
}
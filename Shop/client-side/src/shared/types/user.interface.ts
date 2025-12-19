import { IProduct } from "./product.interface";
import { IStore } from "./store.interface";
import {IOrder} from '@/shared/types/order.interface';

export interface IUser {
  id: string;
  name: string;
  email: string
  picture: string
  favorites: IProduct[]
  orders: IOrder[]
  stores: IStore[]
}
import { IProduct } from "@/shared/types/product.interface"

export interface ICatalog {
  title: string
  description?: string
  linkTitle?: string
  link?: string
  products: IProduct[]
}
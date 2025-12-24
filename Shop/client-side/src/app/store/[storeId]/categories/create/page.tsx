import {Metadata} from 'next'
import {NO_INDEX_PAGE} from '@/constants/seo.constants'
import {CreateProduct} from '@/app/store/[storeId]/products/create/CreateProduct';

export const metadata: Metadata = {
  title: 'Создание товара',
  ...NO_INDEX_PAGE
}

export default function CreateProductPage() {
  return <CreateProduct />
}
import {Metadata} from 'next';
import {NO_INDEX_PAGE} from '@/constants/seo.constants';
import {ProductsEdit} from '@/app/store/[storeId]/products/[productId]/ProductsEdit';

export const metadata: Metadata = {
  title: 'Настройки товара',
  ...NO_INDEX_PAGE
}

export default function ProductsEditPage() {
  return <ProductsEdit />
}
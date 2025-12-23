import {Metadata} from 'next';
import {NO_INDEX_PAGE} from '@/constants/seo.constants';
import Products from '@/app/store/[storeId]/products/Products';

export const metadata: Metadata = {
  title: 'Товары',
  ...NO_INDEX_PAGE
}

export default function ProductsPage() {
  return <Products />
}
import {Metadata} from 'next';
import {NO_INDEX_PAGE} from '@/constants/seo.constants';
import {Colors} from '@/app/store/[storeId]/colors/Colors';

export const metadata: Metadata = {
  title: 'Товары',
  ...NO_INDEX_PAGE
}

export default function ProductsPage() {
  return <Colors />
}
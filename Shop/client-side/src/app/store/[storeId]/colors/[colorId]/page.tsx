import {Metadata} from 'next';
import {NO_INDEX_PAGE} from '@/constants/seo.constants';
import {ColorEdit} from '@/app/store/[storeId]/colors/[colorId]/ColorEdit';

export const metadata: Metadata = {
  title: 'Настройки цвета',
  ...NO_INDEX_PAGE
}

export default function ProductsEditPage() {
  return <ColorEdit />
}
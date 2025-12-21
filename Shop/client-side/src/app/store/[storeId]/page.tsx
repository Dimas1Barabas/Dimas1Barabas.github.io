import {Metadata} from 'next';
import {NO_INDEX_PAGE} from '@/constants/seo.constants';
import Store from '@/app/store/[storeId]/Store';

export const metadata: Metadata = {
  title: "Управление магазином",
  ...NO_INDEX_PAGE,
}

export default function StorePage() {
  return <Store />
}
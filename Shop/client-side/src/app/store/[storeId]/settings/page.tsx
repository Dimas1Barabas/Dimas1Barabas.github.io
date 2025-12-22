import {Metadata} from 'next';
import {NO_INDEX_PAGE} from '@/constants/seo.constants';
import {Settings} from '@/app/store/[storeId]/settings/Settings';

export const metadata: Metadata = {
  title: 'Настройки магазина',
  ...NO_INDEX_PAGE
}

export default function SettingsPage() {
  return (
    <Settings/>
  )
}
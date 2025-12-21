'use client'

import { useParams } from "next/navigation";
import {IMenuItem} from '@/components/layouts/store-layout/sidebar/navigation/menu.interface';
import {STORE_URL} from '@/config/url.config';
import {Album, BarChart, FolderKanban, PaintBucket, Settings, Star} from 'lucide-react';

export default function Navigation() {
  const params = useParams<{ storeId: string }>();
  
  const routes: IMenuItem[] = [
    {
      icon: BarChart,
      link: STORE_URL.home(params.storeId),
      value: 'Статистика'
    },
    {
      icon: FolderKanban,
      link: STORE_URL.home(params.storeId),
      value: 'Товары'
    },
    {
      icon: Album,
      link: STORE_URL.home(params.storeId),
      value: 'Категории'
    },
    {
      icon: PaintBucket,
      link: STORE_URL.home(params.storeId),
      value: 'Цвета'
    },
    {
      icon: Star,
      link: STORE_URL.home(params.storeId),
      value: 'Отзовы'
    },
    {
      icon: Settings,
      link: STORE_URL.home(params.storeId),
      value: 'Настройки магазина'
    }
  ]
  
  return (
    <div></div>
  );
}
'use client'

import {useGetCategory} from '@/hooks/queries/categories/useGetCategory';
import {useGetColor} from '@/hooks/queries/colors/useGetColor';
import {CollorsForm} from '@/app/store/[storeId]/products/ProductsForm';

export  function CreateColor() {
  return (
    <CollorsForm categories={categories || []} colors={colors || []}/>
  );
};
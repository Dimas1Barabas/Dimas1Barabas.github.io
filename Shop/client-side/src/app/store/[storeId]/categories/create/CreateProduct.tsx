'use client'

import {useGetCategory} from '@/hooks/queries/categories/useGetCategory';
import {useGetColor} from '@/hooks/queries/colors/useGetColor';
import {ProductsForm} from '@/app/store/[storeId]/products/ProductsForm';

export  function CreateProduct() {
  const {categories} = useGetCategory()
  const {colors} = useGetColor()
  
  return (
    <ProductsForm categories={categories || []} colors={colors || []}/>
  );
};
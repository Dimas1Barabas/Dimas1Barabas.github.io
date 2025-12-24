'use client'

import {useParams} from 'next/navigation';
import {useQuery} from '@tanstack/react-query';
import {productService} from '@/services/product.service';
import {useGetCategory} from '@/hooks/queries/categories/useGetCategory';
import {useGetColor} from '@/hooks/queries/colors/useGetColor';
import {ProductsForm} from '@/app/store/[storeId]/products/ProductsForm';

export function  ProductsEdit() {
  const params = useParams<{prodauctId: string}>();
  const {data} = useQuery({
    queryKey: ['get product'],
    queryFn: () => productService.getById(params.prodauctId)
  })
  
  const { categories }= useGetCategory()
  const { colors }= useGetColor()
  
  return (
    <ProductsForm categories={categories || []} colors={colors || []} product={data}/>
  );
}
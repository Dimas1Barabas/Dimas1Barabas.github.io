'use client'

import {useParams} from 'next/navigation';
import {useQuery} from '@tanstack/react-query';
import {colorService} from '@/services/color.service';
import {ColorForm} from '@/app/store/[storeId]/colors/ColorForm';

export function  ColorEdit() {
  const params = useParams<{colorId: string}>();
  
  const {data} = useQuery({
    queryKey: ['get product'],
    queryFn: () => colorService.getById(params.colorId)
  })
  
  return (
    <ColorForm color={data}/>
  );
}
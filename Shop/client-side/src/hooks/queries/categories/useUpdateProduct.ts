import { useParams } from "next/navigation";
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {useMemo} from 'react';
import {IProductInput} from '@/shared/types/product.interface';
import {productService} from '@/services/product.service';

export function useUpdateProduct() {
  const params = useParams<{ productId: string }>()
  const queryClient = useQueryClient();
  
  const {mutate: updateProduct, isPending: isLoadingUpdate} = useMutation({
    mutationKey: ['update product'],
    mutationFn: (data: IProductInput) => productService.update(params.productId ,data),
    onSuccess() {
      queryClient.invalidateQueries({
        queryKey: ['get products for store dashboard'],
      });
      toast.success('Товар обновлен');
    },
    onError() {
      toast.error('Ошибка при обновлении товара');
    }
  })
  
  return useMemo(
    () => ({ updateProduct, isLoadingUpdate}),
    [ updateProduct, isLoadingUpdate]
  )
}
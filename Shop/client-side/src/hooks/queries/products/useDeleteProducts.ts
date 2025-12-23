import {useRouter} from 'next/router';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {storeService} from '@/services/store.service';
import {PUBLIC_URL, STORE_URL} from '@/config/url.config';
import {useMemo} from 'react';
import toast from 'react-hot-toast';
import {useParams} from 'next/navigation';
import {productService} from '@/services/product.service';

export function useDeleteProducts() {
  const params = useParams<{ storeId: string, productId: string }>()
  const router = useRouter()
  
  const queryClient = useQueryClient();
  
  const {mutate: deleteProduct, isPending: isLoadingDelete} = useMutation({
    mutationKey: ['delete product'],
    mutationFn: () => productService.delete(params.storeId),
    onSuccess() {
      queryClient.invalidateQueries({
        queryKey: ['get products for store dashboard'],
      })
      toast.success('Товар удален');
      router.push(STORE_URL.products(params.storeId));
    },
    onError() {
      toast.error('Ошибка при удалении товара');
    }
  })
  
  return useMemo(() => ({deleteProduct, isLoadingDelete}),
    [deleteProduct, isLoadingDelete])
}
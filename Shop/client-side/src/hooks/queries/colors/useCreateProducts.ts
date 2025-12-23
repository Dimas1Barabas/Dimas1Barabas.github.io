import {useRouter} from 'next/router';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {storeService} from '@/services/store.service';
import {STORE_URL} from '@/config/url.config';
import {useMemo} from 'react';
import toast from 'react-hot-toast';
import {useParams} from 'next/navigation';
import {IProductInput} from '@/shared/types/product.interface';
import {productService} from '@/services/product.service';

export const useCreateProduct = () => {
  const params = useParams<{ storeId: string }>();
  const router = useRouter()
  
  const queryClient = useQueryClient();
  
  const { mutate: createProduct, isPending: isLoadingCreate } = useMutation({
    mutationKey: ['create product'],
    mutationFn: (data: IProductInput) => productService.create(data, params.storeId),
    onSuccess(store) {
      queryClient.invalidateQueries({
        queryKey: ['get products for store dashboard'],
      });
      toast.success('Товар создан');
      router.push(STORE_URL.products(params.storeId));
    },
    onError() {
      toast.error('Ошибка при создании товара');
    }
  })
  
  return useMemo(
    () => ({
      createProduct,
      isLoadingCreate
    }),
    [createProduct, isLoadingCreate]
  ) // TODO 6 22
}
import {useRouter} from 'next/router';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {IStoreCreate} from '@/shared/types/store.interface';
import {storeService} from '@/services/store.service';
import {STORE_URL} from '@/config/url.config';
import {useMemo} from 'react';
import toast from 'react-hot-toast';

export function useCreateStore() {
  const router = useRouter()
  
  const queryClient = useQueryClient();
  
  const {mutate: CreateStore, isPending: isLoadingCreate} = useMutation({
    mutationKey: ['create store'],
    mutationFn: (data: IStoreCreate) => storeService.create(data),
    onSuccess(store) {
      queryClient.invalidateQueries({
        queryKey: ['profile'],
      });
      toast.success('Магазин создан');
      router.push(STORE_URL.home(store.id));
    },
    onError() {
      toast.error('Ошибка при создании магазина');
    }
  })
  
  return useMemo(() => ({CreateStore, isLoadingCreate}),
    [CreateStore, isLoadingCreate])
}
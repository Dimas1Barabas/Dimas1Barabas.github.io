import { useParams } from "next/navigation";
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query';
import {storeService} from '@/services/store.service';
import {IStoreEdit} from '@/shared/types/store.interface';
import toast from 'react-hot-toast';
import {STORE_URL} from '@/config/url.config';
import {router} from 'next/client';
import {useMemo} from 'react';

export function useUpdateStore() {
  const params = useParams<{ storeId: string }>()
  
  const queryClient = useQueryClient();
  
  const { data: store } = useQuery({
    queryKey: ['store', params.storeId],
    queryFn: () => storeService.getById(params.storeId),
  })
  
  const {mutate: updateStore, isPending: isLoadingUpdate} = useMutation({
    mutationKey: ['update store'],
    mutationFn: (data: IStoreEdit) => storeService.update(params.storeId ,data),
    onSuccess() {
      queryClient.invalidateQueries({
        queryKey: ['profile'],
      });
      toast.success('Магазин обновлен');
    },
    onError() {
      toast.error('Ошибка при обновлении магазина');
    }
  })
  
  return useMemo(
    () => ({store, updateStore, isLoadingUpdate}),
    [store, updateStore, isLoadingUpdate]
  )
}
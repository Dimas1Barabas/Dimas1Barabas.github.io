import {useRouter} from 'next/router';
import {useMutation} from '@tanstack/react-query';
import {storeService} from '@/services/store.service';
import {PUBLIC_URL} from '@/config/url.config';
import {useMemo} from 'react';
import toast from 'react-hot-toast';
import {useParams} from 'next/navigation';

export function useDeleteStore() {
  const params = useParams<{ storeId: string }>()
  const router = useRouter()
  
  const {mutate: deleteStore, isPending: isLoadingDelete} = useMutation({
    mutationKey: ['delete store'],
    mutationFn: () => storeService.delete(params.storeId),
    onSuccess() {
      toast.success('Магазин удален');
      router.push(PUBLIC_URL.home());
    },
    onError() {
      toast.error('Ошибка при удалении магазина');
    }
  })
  
  return useMemo(() => ({deleteStore, isLoadingDelete}),
    [deleteStore, isLoadingDelete])
}
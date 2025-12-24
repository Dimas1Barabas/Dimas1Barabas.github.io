import {useRouter} from 'next/router';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {STORE_URL} from '@/config/url.config';
import {useMemo} from 'react';
import toast from 'react-hot-toast';
import {useParams} from 'next/navigation';
import {colorService} from '@/services/color.service';

export function useDeleteColor() {
  const params = useParams<{ storeId: string, colorId: string }>()
  const router = useRouter()
  
  const queryClient = useQueryClient();
  
  const {mutate: deleteColor, isPending: isLoadingDelete} = useMutation({
    mutationKey: ['delete color'],
    mutationFn: () => colorService.delete(params.colorId),
    onSuccess() {
      queryClient.invalidateQueries({
        queryKey: ['get colors for store dashboard'],
      })
      toast.success('Цвет удален');
      router.push(STORE_URL.colors(params.storeId));
    },
    onError() {
      toast.error('Ошибка при удалении цвета');
    }
  })
  
  return useMemo(() => ({deleteColor, isLoadingDelete}),
    [deleteColor, isLoadingDelete])
}
import { useParams } from "next/navigation";
import {useMutation, useQueryClient} from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {useMemo} from 'react';
import {IColorInput} from '@/shared/types/color.interface';
import {colorService} from '@/services/color.service';

export function useUpdateColor() {
  const params = useParams<{ colorId: string }>()
  const queryClient = useQueryClient();
  
  const {mutate: updateColor, isPending: isLoadingUpdate} = useMutation({
    mutationKey: ['update color'],
    mutationFn: (data: IColorInput) => colorService.update(params.colorId, data),
    onSuccess() {
      queryClient.invalidateQueries({
        queryKey: ['get colors for store dashboard'],
      });
      toast.success('Цвет обновлен');
    },
    onError() {
      toast.error('Ошибка при обновлении цвета');
    }
  })
  
  return useMemo(
    () => ({ updateColor, isLoadingUpdate}),
    [updateColor, isLoadingUpdate]
  )
}
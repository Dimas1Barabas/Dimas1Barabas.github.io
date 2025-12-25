import {useMutation, useQueryClient} from '@tanstack/react-query';
import {reviewService} from '@/services/review.service';
import toast from 'react-hot-toast';
import {useMemo} from 'react';
import {useParams} from 'next/navigation';
import {IReviewInput} from '@/shared/types/review.interface';

export const useCreateReview = (storeId: string) => {
  const params = useParams<{id: string}>();
  
  const queryClient = useQueryClient()
  
  const { mutate: createReview, isPending: isLoadingCreate } = useMutation({
    mutationKey: ['create review'],
    mutationFn: (data: IReviewInput) => reviewService.create(data, params.id, storeId),
    onSuccess() {
      queryClient.invalidateQueries({
        queryKey: ['product'],
      })
      toast.success('Отзыв создан')
    },
    onError() {
      toast.error('ошибка при создании отзыва')
    }
  })
  
  return useMemo(
    () => ({createReview, isLoadingCreate}),
    [createReview, isLoadingCreate]
  )
}
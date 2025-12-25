import {useMutation, useQueryClient} from '@tanstack/react-query';
import {reviewService} from '@/services/review.service';
import toast from 'react-hot-toast';
import {useMemo} from 'react';

export const useDeleteReviews = () => {
  const queryClient = useQueryClient()
  
  const { mutate: deleteReviews, isPending: isLoadingDelete } = useMutation({
    mutationKey: ['delete review'],
    mutationFn: (reviewId: string) => reviewService.delete(reviewId),
    onSuccess() {
      queryClient.invalidateQueries({
        queryKey: ['product'],
      })
      toast.success('Отзыв удален')
    },
    onError() {
      toast.error('ошибка при удалении отзыва')
    }
  })
  
  return useMemo(
    () => ({deleteReviews, isLoadingDelete}),
    [deleteReviews, isLoadingDelete]
  )
}
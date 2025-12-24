import {useRouter} from 'next/router';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import {STORE_URL} from '@/config/url.config';
import {useMemo} from 'react';
import toast from 'react-hot-toast';
import {useParams} from 'next/navigation';
import {categoryService} from '@/services/category.service';

export function useDeleteCategory() {
  const params = useParams<{ storeId: string, categoryId: string }>()
  const router = useRouter()
  
  const queryClient = useQueryClient();
  
  const {mutate: deleteCategory, isPending: isLoadingDelete} = useMutation({
    mutationKey: ['delete category'],
    mutationFn: () => categoryService.delete(params.categoryId),
    onSuccess() {
      queryClient.invalidateQueries({
        queryKey: ['get categories for store dashboard'],
      })
      toast.success('Категория удален');
      router.push(STORE_URL.categories(params.storeId));
    },
    onError() {
      toast.error('Ошибка при удалении категории');
    }
  })
  
  return useMemo(() => ({deleteCategory, isLoadingDelete}),
    [deleteCategory, isLoadingDelete])
}
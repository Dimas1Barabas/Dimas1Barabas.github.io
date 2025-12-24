import {useParams} from 'next/navigation';
import {useQuery} from '@tanstack/react-query';
import {useMemo} from 'react';
import {colorService} from '@/services/color.service';

export const useGetColor = () => {
  const params = useParams<{ storeId: string }>();
  
  const { data: colors, isLoading } = useQuery({
    queryKey: ['get colors for store dashboard'],
    queryFn: () => colorService.getByStoreId(params.storeId),
  });
  
  return useMemo(
    () => ({
      colors,
      isLoading,
    }),
    [colors, isLoading],
  )
}
import {axiosInstance} from '@/services/instance';
import {Product} from '@prisma/client';

export const search = async (query: string) => {
  return (await axiosInstance.get<Product>('/products/search', {params: query})).data
}
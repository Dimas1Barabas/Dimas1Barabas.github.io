import {axiosClassic, axiosWithAuth} from '@/api/api.interceptors';
import {ICategory, ICategoryInput} from '@/shared/types/category.interface';
import {API_URL} from '@/config/api.config';

class CategoryService {
  async getByStoreId(id: string) {
    const {data} = await axiosWithAuth<ICategory[]>({
      url: API_URL.category(`/by-storeId/${id}`),
      method: 'GET',
    })
    
    return data;
  }
  
  async getById(id: string) {
    const {data} = await axiosClassic<ICategory>({
      url: API_URL.category(`/by-id/${id}`),
      method: 'GET',
    })
    
    return data;
  }
  
  async create(data: ICategoryInput, storeId: string) {
    const { data: createdCategory } = await axiosWithAuth<ICategory>({
      url: API_URL.category(`/${storeId}`),
      method: 'POST',
      data
    })
    
    return createdCategory;
  }
  
  async update(id: string, data: ICategoryInput) {
    const { data: updatedCategory } = await axiosWithAuth<ICategory>({
      url: API_URL.category(`/${id}`),
      method: 'PUT',
      data
    })
    
    return updatedCategory;
  }
  
  async delete(id: string) {
    const { data: deleteCategory } = await axiosWithAuth<ICategory>({
      url: API_URL.category(`/${id}`),
      method: 'DELETE',
    })
    
    return deleteCategory;
  }
}

export const categoryService = new CategoryService();
import {axiosWithAuth} from '@/api/api.interceptors';
import {API_URL} from '@/config/api.config';
import {IColor, IColorInput} from '@/shared/types/color.interface';

class ColorService {
  async getByStoreId(id: string) {
    const {data} = await axiosWithAuth<IColor[]>({
      url: API_URL.colors(`/by-storeId/${id}`),
      method: 'GET',
    })
    
    return data || [];
  }
  
  async getById(id: string) {
    const { data } = await axiosWithAuth<IColor>({
      url: API_URL.colors(`/by-id/${id}`),
      method: 'GET',
    })
    
    return data;
  }
  
  async create(data: IColorInput, storeId: string) {
    const { data: createdColor } = await axiosWithAuth<IColor>({
      url: API_URL.colors(`/${storeId}`),
      method: 'POST',
      data
    })
    
    return createdColor;
  }
  
  async update(id: string, data: IColorInput) {
    const { data: updatedColor } = await axiosWithAuth<IColor>({
      url: API_URL.colors(`/${id}`),
      method: 'PUT',
      data
    })
    
    return updatedColor;
  }
  
  async delete(id: string) {
    const { data: deleteColor } = await axiosWithAuth<IColor>({
      url: API_URL.colors(`/${id}`),
      method: 'DELETE',
    })
    
    return deleteColor;
  }
}

export const colorService = new ColorService();
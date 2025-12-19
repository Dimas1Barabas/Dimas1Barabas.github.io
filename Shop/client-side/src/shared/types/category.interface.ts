export interface ICategory {
  id: string
  createdAt: string
  title: string
  description: string
  storeId: string
}

export interface ICategoryInput extends Pick<ICategory, 'title' | 'description' > {}
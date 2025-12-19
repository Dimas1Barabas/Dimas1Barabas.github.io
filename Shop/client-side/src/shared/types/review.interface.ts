import {IUser} from '@/shared/types/user.interface';

export interface IReview {
  id: string
  createdAt: string
  text: string
  rating: number
  user: IUser
}

export interface IReviewInput extends Pick<IReview, 'rating' | 'text'> {}
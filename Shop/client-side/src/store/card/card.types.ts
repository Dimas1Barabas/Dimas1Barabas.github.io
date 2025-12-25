import {ICardItem} from '@/shared/types/card.interface';

export interface ICardInitialState {
  items: ICardItem[]
}

export interface IAddToCardPayload extends Omit<ICardItem, 'id'> {}

export interface IChangeQuantityPayload extends Pick<ICardItem, 'id'> {
  type: 'minus' | 'plus'
}
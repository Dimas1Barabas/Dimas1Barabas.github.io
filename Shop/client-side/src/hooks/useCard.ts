import {useTypedSelector} from '@/hooks/useTypedSelector';

export const useCard = () => {
  const items = useTypedSelector (state => state.card.items);
  
  const total = items.reduce(
    (acc, item) => acc += item.price * item.quantity,
    0
  )
  
  return {items, total}
}
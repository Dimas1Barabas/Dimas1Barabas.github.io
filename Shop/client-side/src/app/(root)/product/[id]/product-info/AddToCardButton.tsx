import {IProduct} from '@/shared/types/product.interface';
import {Button} from '@/components/ui/Button';
import {useActions} from '@/hooks/useActions';
import {useCard} from '@/hooks/useCard';

interface AddToCardButtonProps {
  product: IProduct
}

export function AddToCardButton({ product }: AddToCardButtonProps) {
  const {addToCard, removeFromCard} = useActions()
  const {items} = useCard();
  
  const currentElement = items.find(
    cardItem => cardItem.product.id === product.id
  )
  
  return (
    <Button
      onClick={() =>
    currentElement
      ? removeFromCard({id: currentElement.id})
      : addToCard({
        product,
        quantity: 1,
        price: product.price,
      })}
    >
      {currentElement ? 'Удалить из корзины' : 'Добавить в корзину'}
    </Button>
  )
}
import {ICardItem} from '@/shared/types/card.interface';
import {Button} from '@/components/ui/Button';
import {Minus, Plus} from 'lucide-react';
import {useCard} from '@/hooks/useCard';
import {useActions} from '@/hooks/useActions';

interface CardActionProps {
  item: ICardItem
}

export function CardAction({item}: CardActionProps) {
  const { changeQuantity } = useActions()
  
  const {items} = useCard();
  const quantity = items.find(cardItem => cardItem.id === item.id)?.quantity;
  
  return (
    <div>
      <Button
        onClick={() => changeQuantity({id: item.id, type: 'minus'})}
        variant='ghost'
        size='icon'
        disabled={quantity === 1}
      >
        <Minus />
      </Button>
      
      <input disabled readOnly value={quantity}/>
      
      <Button
        onClick={() => changeQuantity({id: item.id, type: 'plus'})}
        variant='ghost'
        size='icon'
      >
        <Plus />
      </Button>
    </div>
  )
}
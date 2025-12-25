import {IProduct} from '@/shared/types/product.interface';
import {Button} from '@/components/ui/Button';

interface AddToCardButtonProps {
  product: IProduct
}

export function AddToCardButton({ product }: AddToCardButtonProps) {
  return (
    <Button variant='primary' >
      Добавить в корзину
    </Button>
  )
}
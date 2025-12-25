import {Sheet, SheetContent, SheetTrigger} from '@/components/ui/Sheet';
import {Button} from '@/components/ui/Button';
import {Heading} from '@/components/ui/Heading';
import {useCard} from '@/hooks/useCard';
import {CardItem} from '@/components/layouts/main-layout/header/header-menu/header-card/CardItem/CardItem';
import {formatPrice} from '@/utils/string/format-price';
import {useRouter} from 'next/router';
import {useCheckout} from '@/components/layouts/main-layout/header/header-menu/header-card/CardItem/useCheckout';
import { useProfile } from '@/hooks/useProfile';
import {PUBLIC_URL} from '@/config/url.config';

export function HeaderMenu() {
  const route = useRouter()
  
  const {createPayment, isLoadingCreate} = useCheckout()
  const {user} = useProfile()
  
  const {items, total} = useCard()
  
  const handleClick = () => {
    user ? createPayment() : route.push(PUBLIC_URL.auth())
  }
  
  return (
    <Sheet >
      <SheetTrigger>
        <Button variant="ghost" >Корзина</Button>
      </SheetTrigger>
      <SheetContent>
        <Heading title='Козина товаров'/>
        <div>
          {items.length ? (
            items.map((item) => (
              <CardItem item={item} key={item.id}/>
            ))
          ) : (
            <div>Корзина пустая</div>
          )}
        </div>
        {items.length ? (
          <>
            <div>
              Итого к оплате: {formatPrice(total)}
            </div>
            <Button
              onClick={handleClick}
              disabled={isLoadingCreate}
            >
              Перейти к оплате
            </Button>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
import {Sheet, SheetContent, SheetTrigger} from '@/components/ui/Sheet';
import {Button} from '@/components/ui/Button';
import {Heading} from '@/components/ui/Heading';

export function HeaderMenu() {
  return (
    <Sheet >
      <SheetTrigger>
        <Button variant="ghost" >Корзина</Button>
      </SheetTrigger>
      <SheetContent>
        <Heading title='Козина товаров'/>
      </SheetContent>
    </Sheet>
  )
}
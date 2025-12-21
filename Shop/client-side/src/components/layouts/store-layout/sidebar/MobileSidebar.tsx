import {Sheet, SheetContent, SheetTrigger} from '@/components/ui/Sheet';
import {Menu} from 'lucide-react';

function MobileSidebar() {
  return (
    <Sheet>
      <SheetTrigger className='lg:hidden pr-4 hover:opacity-75 transition'>
        <Menu />
      </SheetTrigger>
      <SheetContent side='left' className='p-0 bg-white'></SheetContent>
    </Sheet>
  );
}

export default MobileSidebar;
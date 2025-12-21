import {Sheet, SheetTrigger} from '@/components/ui/Sheet';

function MobileSidebar() {
  return (
    <Sheet>
      <SheetTrigger className='lg:hidden pr-4 hover:opacity-75 transition'></SheetTrigger>
    </Sheet>
  );
}

export default MobileSidebar;
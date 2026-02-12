import {Container, Filters, Title, TopBar} from '@/components';

export default function Home() {
  return (
    <>
      <Container className="mt-10">
        <Title text="Все пиццы" size='lg' className="font-extrabold" />
      </Container>
      
      <TopBar />
      
      <Container className="mt-10 pb-14">
        <div className="flex gap-[60px]">
          
          <div className="w-[250px]">
            <Filters />
          </div>
          
          {/*<div className="flex-1">*/}
          {/*  <div className="flex flex-col gap-16">*/}
          {/*    <ProductsGroupList title="Пиццы" items={[1, 2, 3, 4, 5]} />*/}
          {/*    <ProductsGroupList title="Комбо" items={[1, 2, 3, 4, 5]} />*/}
          {/*  </div>*/}
          {/*  */}
          {/*  <div className="flex items-center gap-6 mt-12">*/}
          {/*    <Pagination pageCount={3} />*/}
          {/*    <span className="text-sm text-gray-400">5 из 65</span>*/}
          {/*  </div>*/}
          {/*</div>*/}
          
          
        </div>
      </Container>
    </>
  );
}

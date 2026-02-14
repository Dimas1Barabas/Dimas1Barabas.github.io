import {Container, Filters, ProductsGroupList, Title, TopBar} from '@/components';

export default function Home() {
  return (
    <>
      <Container className="mt-10">
        <Title text="Все пиццы" size='lg' className="font-extrabold" />
      </Container>
      
      <TopBar />
      <Container className="mt-10 pb-14">
        <div className="flex gap-[80px]">
          
          <div className="w-[250px]">
            <Filters />
          </div>
          
          <div className="flex-1">
            <div className="flex flex-col gap-16">
              <ProductsGroupList
                title="Пиццы"
                items={[
                  {
                    id: 1,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 2,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 3,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                ]}
                categoryId={1}
                className="scroll-mt-[92px]"
              />
              <ProductsGroupList
                title="Комбо"
                items={[
                  {
                    id: 4,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 42,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 53,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 644,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 423,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 523,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 643,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 4676,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5123,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6352,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                ]}
                categoryId={2}
                className="scroll-mt-[92px]"
              />
              <ProductsGroupList
                title="Закуски"
                items={[
                  {
                    id: 4,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 42,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 53,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 644,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 423,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 523,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 643,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 4676,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5123,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6352,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                ]}
                categoryId={3}
                className="scroll-mt-[92px]"
              />
              <ProductsGroupList
                title="Коктейли"
                items={[
                  {
                    id: 4,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 42,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 53,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 644,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 423,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 523,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 643,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 4676,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5123,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6352,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                ]}
                categoryId={4}
                className="scroll-mt-[92px]"
              />
              <ProductsGroupList
                title="Кофе"
                items={[
                  {
                    id: 4,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 42,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 53,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 644,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 423,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 523,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 643,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 4676,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5123,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6352,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                ]}
                categoryId={5}
                className="scroll-mt-[92px]"
              />
              <ProductsGroupList
                title="Напитки"
                items={[
                  {
                    id: 4,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 42,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 53,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 644,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 423,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 523,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 643,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 4676,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5123,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6352,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                ]}
                categoryId={6}
                className="scroll-mt-[92px]"
              />
              <ProductsGroupList
                title="Десерты"
                items={[
                  {
                    id: 4,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 42,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 53,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 644,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 423,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 523,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 643,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 4676,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5123,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6352,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                ]}
                categoryId={7}
                className="scroll-mt-[92px]"
              />
              <ProductsGroupList
                title="Десерты"
                items={[
                  {
                    id: 4,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 42,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 53,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 644,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 423,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 523,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 643,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 4676,
                    name: "Чизбургер",
                    imageUrl: "sdgfsgf",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 5123,
                    name: "Чизбургер",
                    imageUrl: "sgfgdsfgsfg",
                    price: 550,
                    items: [{price: 550}]
                  },
                  {
                    id: 6352,
                    name: "Чизбургер",
                    imageUrl: "dsfggs",
                    price: 550,
                    items: [{price: 550}]
                  },
                ]}
                categoryId={8}
                className="scroll-mt-[92px]"
              />
            </div>
            
            {/*<div className="flex items-center gap-6 mt-12">*/}
            {/*  <Pagination pageCount={3} />*/}
            {/*  <span className="text-sm text-gray-400">5 из 65</span>*/}
            {/*</div>*/}
          </div>
        </div>
      </Container>
    </>
  );
}

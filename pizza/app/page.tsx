import {Categories, Container, Title} from '@/components';
import {SortPopup} from '@/components/shared/sort-popup';

export default function Home() {
  return (
    <>
      <Container className="mt-10">
        <Title text="Все пиццы" size='lg' className="font-extrabold" />
        <Categories />
        <SortPopup />
      </Container>
    </>
  );
}

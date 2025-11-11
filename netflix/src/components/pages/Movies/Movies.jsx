import React from 'react';

import useMoviesQuery from '../../../hooks/useMoviesQuery.jsx';
import BearCarousel, { BearSlideImage } from 'bear-react-carousel';

const Movies = () => {
  const {
    isLoading,
    hasError,
    responsePopular,
    // responseBest,
    // responseFilms,
    // responseSerials,
    // responseCartoons,
  } = useMoviesQuery();
  
  if (isLoading) return <p>Загрузка...</p>;
  if (hasError) return <p>Ошибка...</p>;
  
  const serializeDataForCarousel = data => {
    data.map((row) => (
      <BearSlideImage key={row.id}>
        {row.name}
      </BearSlideImage>
    ));
  };
  
  const carouselArr = [
    {
      title: 'Популярные фильмы',
      url: '/popular',
      data: serializeDataForCarousel(responsePopular.data.items),
    },
  ];
  
  return (
    <div>
      <BearCarousel data={carouselArr[0].data} />
    </div>
  );
};

export default Movies;

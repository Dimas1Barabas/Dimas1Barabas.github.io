import { Link, Stack } from '@mui/material';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';

import useMoviesQuery from '../../../hooks/useMoviesQuery';
import ErrorMessage from '../../ui/ErrorMessage';
import MoviesSkeleton from './MoviesSkeleton';

export default function Movies() {
  const {
    isLoading,
    hasError,
    responsePopular,
    responseBest,
    responseFilms,
    responseSerials,
    responseCartoons,
  } = useMoviesQuery();
  
  if (isLoading) return <MoviesSkeleton />;
  
  if (hasError) return <ErrorMessage />;
  
  const serializeDataForCarousel = data =>
    data.map(row => (
      <RouterLink key={row.id} to={`/movie/${row.kinopoiskId}`}>
        <img src={row.posterUrlPreview} alt={row.name} style={{ width: '230px', height: '352px' }} />
      </RouterLink>
    ));
  
  const carouselArr = [
    {
      title: 'Популярные фильмы',
      url: '/popular',
      data: serializeDataForCarousel(responsePopular.data.items),
    },
    {
      title: 'Лучшие фильмы',
      url: '/best',
      data: serializeDataForCarousel(responseBest.data.items),
    },
    {
      title: 'Фильмы',
      url: '/films',
      data: serializeDataForCarousel(responseFilms.data.items),
    },
    {
      title: 'Сериалы',
      url: '/serials',
      data: serializeDataForCarousel(responseSerials.data.items),
    },
    {
      title: 'Мультфильмы',
      url: '/cartoons',
      data: serializeDataForCarousel(responseCartoons.data.items),
    },
  ];
  
  return (
    <>
      {carouselArr.map(carousel => (
        <Stack key={carousel.title}>
          <Link
            sx={{ mt: 2, mb: 2 }}
            variant="h4"
            component={RouterLink}
            to={carousel.url}
          >
            {carousel.title}
          </Link>
          <div style={{ width: "100%",display: 'inline-flex', overflowX: 'scroll' }}>
            {carousel.data}
          </div>
        </Stack>
      ))}
    </>
  );
}
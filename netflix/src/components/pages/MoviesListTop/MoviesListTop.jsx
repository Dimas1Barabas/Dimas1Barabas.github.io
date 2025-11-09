import { ArrowBack } from '@mui/icons-material';
import { Button, Stack, Typography } from '@mui/material';
import React, { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

import { TOP_LISTS } from '../../../constants.js';
import { useGetFilmsTopQuery } from '../../../services/kinopoiskApi.js';
import MoviesList from '../../ui/MoviesList';

const MoviesListTop = () => {
  const [page, setPage] = useState(1);
  const location = useLocation();
  const navigate = useNavigate();
  const MovieType = TOP_LISTS.find(el => el.url === location.pathname);

  const { data, error, isLoading } = useGetFilmsTopQuery({
    type: MovieType.value,
    page,
  });
  //TODO 2 40
  useEffect(() => {setPage(1)}, [location]);

  if (error) return <p>ошибка</p>;

  if (isLoading) return <p>Загрузка...</p>;

  return (
    <>
      <Stack flexDirection="row" sx={{ mt: 2, md: 2 }}>
        <Button startIcon={<ArrowBack />} onClick={() => navigate(-1)} />
        <Typography variant="h4">{MovieType.title}</Typography>
      </Stack>
      <MoviesList
        movies={data.items}
        totalPages={data.totalPages}
        page={page}
        setPage={setPage}
      />
    </>
  );
};

export default MoviesListTop;

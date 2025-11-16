import { ArrowBack, Language, Movie } from '@mui/icons-material';
import {
  Box,
  Button,
  ButtonGroup,
  CircularProgress,
  Grid,
  Stack,
  Typography,
} from '@mui/material';
import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import {
  useGetFilmQuery,
  useGetSequelsAndPrequelsQuery,
  useGetStaffQuery,
} from '../../../services/kinopoiskApi.js';
import ErrorMessage from '../../ui/ErrorMessage/index.js';
import MovieCard from '../../ui/MovieCard/index.js';
import VideoPlayer from '../../ui/VideoPlayer/index.js';

const MovieDetail = () => {
  const { id } = useParams();
  const navigate = useNavigate();

  const responseFilm = useGetFilmQuery(id);
  const responseSequelsAndPrequels = useGetSequelsAndPrequelsQuery(id);
  const responseStaff = useGetStaffQuery(id);

  if (
    responseFilm.isLoading ||
    responseSequelsAndPrequels.isLoading ||
    responseStaff.isLoading
  ) {
    return (
      <Box display="flex" justifyContent="center" margin="auto">
        <CircularProgress size="8rem" />
      </Box>
    );
  }

  if (responseFilm.error || responseStaff.error) {
    return <ErrorMessage />;
  }

  return (
    <>
      <Grid container spacing={2} sx={{ mt: { md: 2 } }}>
        <Grid item md={4} sm={12}>
          <img
            src={responseFilm.data.posterUrl}
            alt={responseFilm.data.nameRu}
            width="100%"
          />
        </Grid>
        <Grid item md={6} sm={12}>
          <Grid container>
            <Grid item xs={2}>
              <Button
                startIcon={<ArrowBack />}
                size="large"
                onClick={() => navigate(-1)}
              />
            </Grid>
            <Grid item xs={4} alignContent="center">
              <Typography variant="h5">{responseFilm.data.nameRu}</Typography>
            </Grid>
          </Grid>
          <Grid container>
            <Grid item xs={6}>
              <Typography>Год</Typography>
            </Grid>
            <Grid item xs={6}>
              <Typography gutterBottom>{responseFilm.data.year}</Typography>
            </Grid>

            <Grid item xs={6}>
              <Typography>Страна(ы):</Typography>
            </Grid>
            <Grid item xs={6}>
              {responseFilm.data.countries.map(({ country }) => (
                <Typography gutterBottom key={country}>
                  {country}
                </Typography>
              ))}
            </Grid>

            <Grid item xs={6}>
              <Typography>Жанры:</Typography>
            </Grid>
            <Grid item xs={6}>
              {responseFilm.data.genres.map(({ genre }) => (
                <Typography gutterBottom key={genre}>
                  {genre}
                </Typography>
              ))}
            </Grid>

            <Grid item xs={6}>
              <Typography>Режиссеры:</Typography>
            </Grid>
            <Grid item xs={6}>
              {responseStaff.data
                .filter(el => el.professionText === 'Режиссеры')
                .map(({ nameRu }) => (
                  <Typography gutterBottom key={nameRu}>
                    {nameRu}
                  </Typography>
                ))}
            </Grid>

            <Grid item xs={6}>
              <Typography>Хронометраж:</Typography>
            </Grid>
            <Grid item xs={6}>
              <Typography gutterBottom>
                {responseFilm.data.filmLength
                  ? `${responseFilm.data.filmLength} мин.`
                  : 'Нет данных'}
              </Typography>
            </Grid>

            <Grid item xs={12}>
              <Typography>Описание:</Typography>
            </Grid>
            <Grid item xs={12}>
              <Typography gutterBottom>
                {responseFilm.data.description
                  ? responseFilm.data.description
                  : 'Описание отсутствует'}
              </Typography>
            </Grid>
          </Grid>
        </Grid>
        <Grid item md={2} sm={12}>
          <Typography>В главных ролях:</Typography>
          {responseStaff.data
            .filter(el => el.professionText === 'Актеры')
            .slice(0, 10)
            .map(({ nameRu }) => (
              <Typography gutterBottom key={nameRu}>
                {nameRu}
              </Typography>
            ))}
        </Grid>
      </Grid>

      <Grid
        container
        spacing={2}
        display="flex"
        justifyContent="center"
        alignItems="center"
        flexDirection="column"
      >
        <Grid item xs={12}>
          <ButtonGroup variant="outlined" size="small">
            <Button
              target="_blank"
              href={responseFilm.data.webUrl}
              endIcon={<Language />}
            >
              Кинопоиск
            </Button>
            <Button
              target="_blank"
              href={`https://www.imdb.com/title/${responseFilm.data.imdbId}`}
              endIcon={<Movie />}
            >
              IMDB
            </Button>
          </ButtonGroup>
        </Grid>
        <Grid item xs={12}>
          <Typography textAlign="center" variant="h5">
            Смотреть онлайн
          </Typography>
          <VideoPlayer />
        </Grid>
        {responseSequelsAndPrequels.data ? (
          <Stack display="flex" alignItems="center" justifyContent="center">
            <Typography gutterBottom variant="h5">
              Сиквелы и приквелы:
            </Typography>
            <Stack
              direction="row"
              flexWrap="wrap"
              justifyContent="center"
              sx={{ gap: 2 }}
            >
              {responseSequelsAndPrequels.data.map(el => (
                <MovieCard movie={el} key={el.filmId} reload />
              ))}
            </Stack>
          </Stack>
        ) : (
          <Typography textAlign="center" variant="h5">
            Сиквелы и Приквелы отсутствуют,
            <br /> ещё не сняли...
          </Typography>
        )}
      </Grid>
    </>
  );
};

export default MovieDetail;

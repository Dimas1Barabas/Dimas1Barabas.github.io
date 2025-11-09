import { Box, Link, Rating, Stack, Tooltip } from '@mui/material';
import React from 'react';
import { Link as RouterLink } from 'react-router-dom';



import styles from './MovieCard.module.css';


const MovieCard = ({ movie }) => {
  return (
    <Stack>
      <RouterLink to={`/movie/${movie.kinoposkId}`}>
        <img
          className={styles.img}
          src={movie.posterUrlPreview}
          alt={movie.nameRu}
        />
      </RouterLink>
      <Link
        component={RouterLink}
        to={`/movie/${movie.kinoposkId}`}
        textAlign="center"
        sx={{ width: '200px' }}
      >
        {movie.nameRu ? movie.nameRu : movie.nameEn}
      </Link>

      {movie.ratingKinopoisk && (
        <Stack alignItems="center">
          <Tooltip title={`${movie.ratingKinopoisk} / 10`}>
            <Box>
              <Rating
                name="read-only"
                value={movie.ratingKinopoisk / 2}
                readOnly
                precision={0.01}
              />
            </Box>
          </Tooltip>
        </Stack>
      )}
    </Stack>
  );
};

export default MovieCard;

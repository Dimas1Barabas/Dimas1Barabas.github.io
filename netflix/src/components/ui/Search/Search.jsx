import { Autocomplete, CircularProgress, TextField } from '@mui/material';
import React, { useEffect, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';

import { setSearchQuery } from '../../../features/searchQuerySlice.js';
import { useGetFilmsQuery } from '../../../services/kinopoiskApi.js';

const movieTypes = {
  FILM: 'Фильм',
  TV_SERIES: 'Сериал',
  TV_SHOW: 'ТВ-Шоу',
  MINI_SERIES: 'Мини-сериал',
};

const Search = () => {
  const dispath = useDispatch();
  const [input, setInput] = useState('');
  const navigate = useNavigate();
  const { countries, genreId, order, type, year, page, keyword } = useSelector(
    state => state.searchQuerySlice,
  );

  useEffect(() => {
    const setTimeoutId = setTimeout(() => {
      dispath(setSearchQuery({ keyword: input }));
    }, 500);
    return () => clearTimeout(setTimeoutId);
  }, [input]);

  const { data, isFetching } = useGetFilmsQuery({
    countries,
    genreId,
    order,
    type,
    year,
    page,
    keyword,
  });

  return (
    <Autocomplete
      freeSolo
      sx={{
        width: 300,
        backgroundColor: 'rgba(255, 255, 255, 0.15)',
        '& .MuiOutLinedInput-root': {
          '& fieldset': {
            border: 'none',
          },
        },
      }}
      getOptionalLabel={option =>
        `${option.nameRu} - ${movieTypes[option.type]} - ${option.year}`
      }
      options={data ? data.items : []}
      onInputChange={(_, value) => {
        setInput(value);
      }}
      onChange={(_, value) => {
        navigate(`/movie/${value.kinopoiskId}`);
      }}
      renderInput={params => (
        <TextField
          {...params}
          label="Поиск"
          inputProps={{
            ...params.InputProps,
            endAdornment: (
              <React.Fragment>
                {isFetching ? (
                  <CircularProgress size={20} color="inherit" />
                ) : null}
                {params.InputProps.endAdornment}
              </React.Fragment>
            ),
          }}
        />
      )}
    />
  );
};

export default Search;

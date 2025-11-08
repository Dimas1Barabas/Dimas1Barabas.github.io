import { createApi, fetchBaseQuery } from '@reduxjs/toolkit/query/react';
//TODO 1 45
export const kinopoiskApi = createApi({
  reducerPath: 'kinopoiskApi',
  baseQuery: fetchBaseQuery({
    baseUrl: 'https://kinopoiskapiunofficial.tech/api',
  }),
  endpoints: builder => ({
    getFilmsTop: builder.query({
      query: (type, page) =>
        `/v2.2/films/collections&type=${type}&page=${page}`,
    }),
  }),
});

export const { useGetFilmsTopQuery } = kinopoiskApi;

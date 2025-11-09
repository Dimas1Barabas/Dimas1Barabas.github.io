import { configureStore } from '@reduxjs/toolkit';

import { currentQuerySlice as currentQueryReducer } from '../features/currentQuerySlice.js';
import { kinopoiskApi } from '../services/kinopoiskApi.js';

export const store = configureStore({
  reducer: {
    [kinopoiskApi.reducerPath]: kinopoiskApi.reducer,
    currentSlice: currentQueryReducer,
  },
  middleware: getDefaultMiddleware =>
    getDefaultMiddleware().concat(kinopoiskApi.middleware),
});

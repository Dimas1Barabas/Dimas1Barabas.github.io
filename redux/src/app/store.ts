import {
  configureStore,
} from '@reduxjs/toolkit';
import {usersSlice} from '../modules/users/users.slice.ts';
import {counterReducer} from '../modules/counters/counters.slice.ts';
import {baseApi} from '../shared/api.ts';
import {router} from './router.tsx';

export const extraArgument = {
  router,
}

export const store = configureStore({
  reducer: {
    counters: counterReducer,
    [usersSlice.name]: usersSlice.reducer,
    [baseApi.reducerPath]: baseApi.reducer,
  },
  
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({ thunk: {extraArgument}}).concat(
      baseApi.middleware
    )
})
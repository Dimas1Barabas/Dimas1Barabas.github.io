import {
  configureStore,
} from '@reduxjs/toolkit';
import {usersSlice} from '../modules/users/users.slice.ts';
import {counterReducer} from '../modules/counters/counters.slice.ts';
import {api} from '../shared/api.ts';
import {router} from './router.tsx';

export const extraArgument = {
  api,
  router,
}

export const store = configureStore({
  reducer: {
    counters: counterReducer,
    [usersSlice.name]: usersSlice.reducer,
  },
  
  middleware: (getDefaultMiddleware) => {
    getDefaultMiddleware({ thunk: {extraArgument}})
  }
})
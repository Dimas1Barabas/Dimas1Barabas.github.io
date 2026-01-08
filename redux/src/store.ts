import {
  configureStore,
  createSelector,
  type ThunkAction,
  type UnknownAction
} from '@reduxjs/toolkit';
import {useDispatch, useSelector, useStore} from 'react-redux';
import {usersSlice} from './modules/users/users.slice.ts';
import {counterReducer} from './modules/counters/counters.slice.ts';
import {api} from './shared/api.ts';

const extraArgument = {
  api,
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

export type AppSate = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
export type AppThunk<R = void> = ThunkAction<
  R,
  AppSate,
  typeof extraArgument,
  UnknownAction
>

export const useAppSelector = useSelector.withTypes<AppSate>()
export const useAppDispatch = useDispatch.withTypes<AppDispatch>()
export const useAppStore = useStore.withTypes<typeof store>()
export const createAppSelector = createSelector.withTypes<AppSate>()

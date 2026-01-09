import {
  asyncThunkCreator,
  buildCreateSlice,
  createAsyncThunk,
  createSelector,
  type ThunkAction,
  type UnknownAction
} from '@reduxjs/toolkit';
import {useDispatch, useSelector, useStore} from 'react-redux';
import type {extraArgument, store} from '../app/store.ts';

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
  export const createAppAsyncThunk = createAsyncThunk.withTypes<{
    state: AppSate
    dispatch: AppDispatch
    extra: typeof extraArgument
  }>()

export type ExtraArgument = typeof extraArgument

export const createSlice = buildCreateSlice({
  creators: {asyncThunk: asyncThunkCreator}
})
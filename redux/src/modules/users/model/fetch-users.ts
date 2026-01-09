import {createAppAsyncThunk} from '../../../shared/redux.ts';
import type {GetThunkAPI} from '@reduxjs/toolkit';
import {usersSlice} from '../users.slice.ts';

export const fetchUsers = createAppAsyncThunk(
  'users/fetchUsers',
  async (_: { refetch?: boolean } = {}, thunkAPI) =>
    thunkAPI.extra.api.getUsers(), {
      condition(params, {getState}) {
        const isIdle = usersSlice.selectors.selectIsFetchingUsersIdle(getState())
        
        if(!params?.refetch && !isIdle) {
          return false
        }
        
        return true
      }
    }
  )
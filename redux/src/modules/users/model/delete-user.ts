import {type UserId} from '../users.slice.ts';
import {usersApi} from '../api.ts';
import type {AppThunk} from '../../../shared/redux.ts';

export const deleteUser =
  (userId: UserId): AppThunk<Promise<void>> =>
    async (dispatch, _, { router  }) => {
      try {
        await dispatch(usersApi.endpoints.deleteUser.initiate(userId, {track: false}))
        await router.navigate('/users')
        await dispatch(usersApi.util.invalidateTags(['Users']))
      } catch (error) {
      
      }
    }
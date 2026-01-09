import {type AppThunk} from '../../../app/store.ts';
import {type UserId, usersSlice} from '../users.slice.ts';
import {fetchUsers} from './fetch-users.ts';

export const deleteUser =
  (userId: UserId): AppThunk<Promise<void>> =>
    async (dispatch, _, { api, router  }) => {
      dispatch(usersSlice.actions.deleteUserPending())
      try {
        await api.deleteUser(userId)
        await router.navigate('/users')
        await dispatch(fetchUsers({refetch: true}))
        dispatch(usersSlice.actions.deleteUserSuccess({userId}))
      } catch (e) {
        dispatch(usersSlice.actions.deleteUserFailed())
      }
    }
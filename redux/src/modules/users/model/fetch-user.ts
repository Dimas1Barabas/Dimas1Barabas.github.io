import {type AppThunk} from '../../../store.ts';
import {type UserId, usersSlice} from '../users.slice.ts';

export const fetchUser =
  (userId: UserId): AppThunk =>
  (dispatch, getState, { api }) => {
  const isPending = usersSlice.selectors.selectIsFetchUserPending(
    getState()
  )
  if(!isPending) {
    return
  }
  
  dispatch(usersSlice.actions.fetchUserPending())
  
  api
    .getUser(userId)
    .then(user => {
      dispatch(usersSlice.actions.fetchUserSuccess({ user }))
    })
    .catch(() => {
      dispatch(usersSlice.actions.fetchUserFailed())
    });
}
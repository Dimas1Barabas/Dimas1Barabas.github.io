import {usersSlice} from '../users.slice.ts';
import {api} from '../../../shared/api.ts';
import {type AppDispatch, type AppSate} from '../../../store.ts';

export const fetchUsers = (dispatch: AppDispatch, getState: () => AppSate) => {
  const isIdle = usersSlice.selectors.selectIsFetchingUsersIdle(
    getState()
  )
  if(!isIdle) {
    return
  }
  
  dispatch(usersSlice.actions.fetchUsersPending())
  
  api
    .getUsers()
    .then(users => {
      dispatch(usersSlice.actions.fetchUsersSuccess({ users }))
    })
    .catch(() => {
      dispatch(usersSlice.actions.fetchUsersFailed())
    });
}
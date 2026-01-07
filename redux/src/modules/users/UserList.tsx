import {memo, useEffect, useState} from 'react';
import {
  useAppDispatch,
  useAppSelector, useAppStore
} from '../../store.ts';
import {
  type UserId, usersSlice
} from './users.slice.ts';
import {useDispatch} from 'react-redux';
import {fetchUsers} from './model/fetch-users.ts';

export function UserList() {
  const dispatch = useDispatch()
  const appStore = useAppStore();
  const [sortType, setSortType] = useState<'asc' | 'desc'>('asc')
  
  const isPending = useAppSelector(usersSlice.selectors.selectIsFetchingUsersPending)
    fetchUsers(appStore.dispatch, appStore.getState)
  useEffect(() => {

  }, [dispatch, appStore]);
  
  const sortedUsers = useAppSelector((state) =>
    usersSlice.selectors.selectSortedUsers(state, sortType)
  )
  
  const selectedUserId = useAppSelector(usersSlice.selectors.selectSelectedUserId)
  
  if(isPending) return (
    <div>Loading...</div>
  )
  
  return (
    <div>
      {!selectedUserId ? (
        <div>
          <div>
            <button onClick={() => setSortType('asc')}>ASC</button>
            <button onClick={() => setSortType('desc')}>DESK</button>
          </div>
          <ul>
            {sortedUsers.map((user: any) => (
              <UserListItem userId={user.id} key={user.id}/>
            ))}
          </ul>
        </div>
      ) : (
        <SelectedUser userId={selectedUserId}/>
      )}
    </div>
  );
};

const UserListItem = memo(function UserListItem({
  userId
}: {
  userId: UserId
}) {
  const user: any = useAppSelector((state) => state.users.entities[userId])
  const dispatch = useAppDispatch();
  
  const handleUserClick = () => {
    dispatch(usersSlice.actions.selected({ userId }))
  }
  
  return (
    <li key={user.id} onClick={handleUserClick}>
      <span>{user.name}</span>
    </li>
  )
})

function SelectedUser({userId}: { userId: UserId }) {
  const user: any = useAppSelector((state) => state.users.entities[userId])
  const dispatch = useAppDispatch();
  
  const handleBackButtonClick = () => {
    dispatch(usersSlice.actions.selectRemove())
  }
  return (
    <div>
      <button onClick={handleBackButtonClick}>Back</button>
      <h2>{user.name}</h2>
      <p>{user.description}</p>
    </div>
  )
}
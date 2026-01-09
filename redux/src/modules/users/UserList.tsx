import {memo, useState} from 'react';
import {
  useAppDispatch,
  useAppSelector
} from '../../app/store.ts';
import {
  type UserId, usersSlice
} from './users.slice.ts';
import {useNavigate} from 'react-router-dom';

export function UserList() {
  const [sortType, setSortType] = useState<'asc' | 'desc'>('asc')
  
  const isPending = useAppSelector(usersSlice.selectors.selectIsFetchingUsersPending)
  
  const sortedUsers = useAppSelector((state) =>
    usersSlice.selectors.selectSortedUsers(state, sortType)
  )
  
  if(isPending) return (
    <div>Loading...</div>
  )
  
  return (
    <div>
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
    </div>
  );
};

const UserListItem = memo(function UserListItem({
  userId
}: {
  userId: UserId
}) {
  const navigate = useNavigate()
  const user: any = useAppSelector((state) => state.users.entities[userId])
  const dispatch = useAppDispatch();
  
  const handleUserClick = () => {
    navigate(userId, {relative: 'path'})
  }
  
  if(!user) {
    return null
  }
  
  return (
    <li key={user.id} onClick={handleUserClick}>
      <span>{user.name}</span>
    </li>
  )
})


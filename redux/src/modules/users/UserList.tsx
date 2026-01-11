import {memo, useMemo, useState} from 'react';
import {
  type User,
} from './users.slice.ts';
import {useNavigate} from 'react-router-dom';
import {usersApi} from './api.ts';

export function UserList() {
  const [sortType, setSortType] = useState<'asc' | 'desc'>('asc')
  
  const { data: users, isLoading} = usersApi.useGetUsersQuery()
  
  const sortedUsers = useMemo(() => {
    return [...(users ?? [])]?.sort( (a, b) => {
        if(sortType === 'asc') {
          return a.name.localeCompare(b.name);
        } else {
          return b.name.localeCompare(a.name);
        }
      })
  }, [users, sortType])
  
  if(isLoading) return (
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
              <UserListItem user={user.id} key={user.id}/>
            ))}
          </ul>
        </div>
    </div>
  );
};

const UserListItem = memo(function UserListItem({
  user
}: {
  user: User
}) {
  const navigate = useNavigate()
  const handleUserClick = () => {
    navigate(user.id, {relative: 'path'})
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


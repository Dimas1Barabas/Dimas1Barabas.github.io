import {useState} from 'react';
import {
  type AppSate, createAppSelector,
  useAppDispatch,
  useAppSelector,
  type User, type UserId,
  type UserRemoveSelectedAction,
  type UserSelectedAction
} from './store.ts';

const selectSortedUsers =
  createAppSelector(
    (state: AppSate) => state.users.ids,
    (state: AppSate) => state.users.entities,
    (_: AppSate, sort: 'asc' | 'desc') => sort,
    (ids, entities, sort) =>
      ids
        .map(id => entities[id])
        .sort((a, b) => {
          if(sort === 'asc') {
            return a.name.localeCompare(b.name);
          } else {
            return b.name.localeCompare(a.name);
          }
        })
  )

const selectSelectedUser = (state: AppSate) =>
  state.users.selectedUserId
    ? state.users.entities[state.users.selectedUserId]
    : undefined



export function UserList() {
  const [sortType, setSortType] = useState<'asc' | 'desc'>('asc')
  
  const sortedUsers = useAppSelector((state) =>
    selectSortedUsers(state, sortType)
  )
  
  const selectedUser = useAppSelector(selectSelectedUser)
  
  return (
    <div>
      {!selectedUser ? (
        <div>
          <div>
            <button onClick={() => setSortType('asc')}>ASC</button>
            <button onClick={() => setSortType('desc')}>DESK</button>
          </div>
          <ul>
            {sortedUsers.map((user) => (
              <UserListItem user={user} key={user.id} />
            ))}
          </ul>
        </div>
      ) : (
        <SelectedUser user={selectedUser} />
      )}
    </div>
  );
};

function UserListItem({ user }: { user: User }) {
  const dispatch = useAppDispatch();
  
  const handleUserClick = () => {
    dispatch({
      type: 'userSelected',
      payload: { userId: user.id },
    } satisfies UserSelectedAction)
  }
  return (
    <li key={user.id} onClick={handleUserClick}>
      <span>{user.name}</span>
    </li>
  )
}

function SelectedUser({ userId }: { userId: UserId }){
  const user = useAppSelector((state) => state.users.entities[userId])
  const dispatch = useAppDispatch();
  
  const handleBackButtonClick = () => {
    dispatch({
      type: 'userRemoveSelected',
    } satisfies UserRemoveSelectedAction)
  }
  return (
    <div>
      <button onClick={handleBackButtonClick}>Back</button>
      <h2>{user.name}</h2>
      <p>{user.description}</p>
    </div>
  )
}
import {type UserId} from './users.slice.ts';
import {useNavigate, useParams} from 'react-router-dom';
import {usersApi} from './api.ts';
import {skipToken} from '@reduxjs/toolkit/query';
import {useAppSelector} from '../../shared/redux.ts';
import {deleteUser} from './model/delete-user.ts';

export function UserInfo() {
  const dispatch = useAppDispatch();
  const navigate = useNavigate()
  const {id} = useParams<{id: UserId}>()
  const {data: user, isLoading: isLoadingUser} = usersApi.useGetUserQuery(id ?? skipToken)
  
  const  isLoadingDelete = useAppSelector((state) =>
    usersApi.endpoints.deleteUser.select(id ?? skipToken)(state).isLoading
  )
  
  const handleBackButtonClick = () => {
    navigate('..', {relative: 'path'})
  }
  
  const handleDeleteButtonClick = async () => {
    if(!id) return
    
    await dispatch(deleteUser(id))
    navigate('..', {relative: 'path'})
  }
  
  if(isLoadingUser || !user) {
    return <div>Loading...</div>
  }
  
  return (
    <div>
      <button onClick={handleBackButtonClick}>Back</button>
      <h2>{user.name}</h2>
      <p>{user.description}</p>
      <button
        disabled={isLoadingDelete}
        onClick={handleDeleteButtonClick}
      >
        Delete
      </button>
    </div>
  )
}
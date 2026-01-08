import {type UserId, usersSlice} from './users.slice.ts';
import {useAppDispatch, useAppSelector} from '../../store.ts';
import {useNavigate, useParams} from 'react-router-dom';
import {useEffect} from 'react';
import {fetchUser} from './model/fetch-user.ts';

export function UserInfo() {
  const dispatch = useAppDispatch()
  const navigate = useNavigate()
  const {id = ""} = useParams<{id: UserId}>()
  const isPending = useAppSelector(
    usersSlice.selectors.selectIsFetchUserPending
  )
  const user: any = useAppSelector((state) =>
    usersSlice.selectors.selectUserById(state, id)
  )
  
  useEffect(() => {
    dispatch(fetchUser(id))
  }, []);
  
  const handleBackButtonClick = () => {
    navigate('..', {relative: 'path'})
  }
  
  if(isPending || !user) {
    return <div>Loading...</div>
  }
  
  return (
    <div>
      <button onClick={handleBackButtonClick}>Back</button>
      <h2>{user.name}</h2>
      <p>{user.description}</p>
    </div>
  )
}
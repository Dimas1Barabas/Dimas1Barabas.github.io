import './App.css'
import {
  type CounterId,
  type DecrementAction,
  type IncrementAction,
  selectCounter,
  useAppSelector
} from './store.ts';
import {useDispatch} from 'react-redux';
import {UserList} from './UserList.tsx';

function App() {
  
  return (
    <div className="card">
      <Counter counterId={'first'}/>
      <Counter counterId={'second'}/>
      
      <UserList />
    </div>
  )
}

export function Counter({ counterId }: {counterId: CounterId}) {
  const dispatch = useDispatch()
  const counterState = useAppSelector(state => selectCounter(state, counterId))
  
  return (
    <>
      counter {counterState?.counter}
      <button
        onClick={() =>
        dispatch({ type: 'increment', payload: { counterId } } satisfies IncrementAction)
        }
      >
        Increment
      </button>
      <button
        onClick={() =>
        dispatch({ type: 'decrement', payload: { counterId } } satisfies DecrementAction)
        }
      >
        Decrement
      </button>
    </>
  )
}

export default App

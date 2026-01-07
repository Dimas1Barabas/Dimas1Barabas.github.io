import './App.css'
import {UserList} from './modules/users/UserList.tsx';
import {Counter} from './modules/counters/counters.tsx';

function App() {
  
  return (
    <div className="card">
      <Counter counterId={'first'}/>
      <Counter counterId={'second'}/>
      <UserList />
    </div>
  )
}

export default App

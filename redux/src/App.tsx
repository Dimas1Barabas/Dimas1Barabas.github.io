import './App.css'
import {store} from './store.ts';
import {useEffect, useReducer} from 'react';

function App() {
  const [_, forceUpdate] = useReducer((x) => x + 1, 0)
  
  useEffect(() => {
    const unsubsribe = store.subscribe(() => {
      forceUpdate()
    });
    
    return unsubsribe
  }, []);
  // TODO 45
  
  return (
    <div className="card">
      counter {store.getState().counters}
      <button onClick={() =>
        store.dispatch({ type: 'increment' })
      }>
        Increment
      </button>
      <button onClick={() =>
        store.dispatch({ type: 'decrement' })
      }>
        Decrement
      </button>
    </div>
  )
}

export default App

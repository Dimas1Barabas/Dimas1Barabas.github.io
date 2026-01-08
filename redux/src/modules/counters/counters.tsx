import {type CounterId, decrementAction, incrementAction, selectCounter} from './counters.slice.ts';
import {useDispatch} from 'react-redux';
import {useAppSelector} from '../../store.ts';
import {bindActionCreators} from '@reduxjs/toolkit';

export function Counter({ counterId = 'first' }: {counterId: CounterId}) {
  const dispatch = useDispatch()
  const counterState = useAppSelector(state =>
    selectCounter(state, counterId)
  )
  console.log('render counter', counterId)
  const actions = bindActionCreators({
    incrementAction,
    decrementAction
  }, dispatch);
  return (
    <>
      counter {counterState?.counter}
      <button
        onClick={() =>
          actions.incrementAction({counterId})
        }
      >
        Increment
      </button>
      <button
        onClick={() =>
          actions.decrementAction({counterId})
        }
      >
        Decrement
      </button>
    </>
  )
}
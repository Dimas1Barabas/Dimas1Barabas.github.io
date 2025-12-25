import {useDispatch} from 'react-redux';
import {bindActionCreators} from 'redux';
import {rootActions} from '@/store/root-actions';
import {useMemo} from 'react';

export const useActions = () => {
  const dispatch = useDispatch();
  
  return useMemo(() => bindActionCreators(rootActions, dispatch), [dispatch]);
}
import {type TypedUseSelectorHook, useSelector} from 'react-redux';

export const useTypedSelector: TypedUseSelectorHook<RootState> = useSelector()
export interface AuthState {
  isAuth: boolean
}

export enum AuthActionsEnum {
  SET_AUTH = 'SET_AUTH'
}

export interface SetAuthAction {
  type: AuthActionsEnum.SET_AUTH
  payload: boolean
}

export type AuthActions = SetAuthAction
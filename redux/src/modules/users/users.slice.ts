
export type UserId = string;

export type User = {
  id: UserId;
  name: string;
  description: string;
}

type UserState = {
  entities: Record<UserId, User | undefined>;
  ids: UserId[];
  fetchingUsersStatus: 'idle' | "pending" | "success" | "failed";
  fetchUserStatus: 'idle' | "pending" | "success" | "failed";
  deleteUserStatus: 'idle' | "pending" | "success" | "failed";
}
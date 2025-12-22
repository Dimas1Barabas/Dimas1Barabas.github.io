export interface IMainStatistics {
  id: number;
  name: string;
  value: number;
}

export interface IMonthlySales {
  data: string
  value: number
}

export interface ILastUsers {
  id: string;
  name: string;
  email: string;
  picture: string;
  total: number;
}

export interface IMiddleStatistics {
  monthlySales: IMonthlySales[]
  lastUser: ILastUser[]
}
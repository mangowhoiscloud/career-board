export type Status =
  | 'ready'
  | 'submitted'
  | 'screening'
  | 'assignment'
  | 'interview'
  | 'offer'
  | 'rejected-docs'
  | 'rejected-assignment'
  | 'rejected-interview'
  | 'hold'

export const STATUS_LABEL: Record<Status, string> = {
  ready: '준비',
  submitted: '제출',
  screening: '서류통과',
  assignment: '과제',
  interview: '면접',
  offer: '오퍼',
  'rejected-docs': '서류탈락',
  'rejected-assignment': '과제탈락',
  'rejected-interview': '면접탈락',
  hold: '보류',
}

export const STATUS_COLOR: Record<Status, string> = {
  ready: '#8B949E',
  submitted: '#58A6FF',
  screening: '#BC8CFF',
  assignment: '#F2CC60',
  interview: '#56D364',
  offer: '#3FB950',
  'rejected-docs': '#F85149',
  'rejected-assignment': '#FF7B72',
  'rejected-interview': '#C93C37',
  hold: '#6E7681',
}

export const STATUS_ORDER: Status[] = [
  'ready',
  'submitted',
  'screening',
  'assignment',
  'interview',
  'offer',
  'rejected-docs',
  'rejected-assignment',
  'rejected-interview',
  'hold',
]

export interface HistoryEntry {
  at: string
  from: Status | ''
  to: Status
  by: string
}

export interface DocRef {
  label: string
  path: string
}

export interface Application {
  id: string
  company: string
  role: string
  wave: string
  channel?: string
  url?: string
  yearsReq?: string
  submitted?: string | null
  status: Status
  notes?: string
  docs?: DocRef[]
  history?: HistoryEntry[]
}

export interface BoardData {
  schema: number
  updated: string
  applications: Application[]
}

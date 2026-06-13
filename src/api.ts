import type { BoardData } from './types'

const OWNER = 'mangowhoiscloud'
const REPO = 'career-data'
const PATH = 'data/applications.json'
const API = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`

export const DATA_REPO_URL = `https://github.com/${OWNER}/${REPO}`

export function b64decodeUtf8(b64: string): string {
  const bin = atob(b64.replace(/\n/g, ''))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

function b64encodeUtf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  bytes.forEach((b) => (bin += String.fromCharCode(b)))
  return btoa(bin)
}

export interface Fetched {
  data: BoardData
  sha: string
}

export function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}
const headers = apiHeaders

export async function fetchBoard(token: string): Promise<Fetched> {
  const res = await fetch(API, { headers: headers(token) })
  if (res.status === 401) throw new Error('토큰이 유효하지 않습니다 (401)')
  if (res.status === 404) throw new Error('데이터 저장소 접근 불가 (404) — 토큰 권한을 확인하세요')
  if (!res.ok) throw new Error(`데이터 로드 실패 (${res.status})`)
  const json = await res.json()
  return { data: JSON.parse(b64decodeUtf8(json.content)) as BoardData, sha: json.sha }
}

export async function commitBoard(
  token: string,
  data: BoardData,
  sha: string,
  message: string,
): Promise<string> {
  const body = {
    message,
    content: b64encodeUtf8(JSON.stringify(data, null, 2) + '\n'),
    sha,
  }
  const res = await fetch(API, {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 409) throw new Error('충돌: 다른 곳에서 먼저 수정됨 — 새로고침 후 재시도')
  if (!res.ok) throw new Error(`커밋 실패 (${res.status})`)
  const json = await res.json()
  return json.content.sha as string
}

/* ── career-data 범용 파일 입출력 (메일함·러너 상태가 공유) ── */

export function fileUrl(path: string): string {
  return `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURI(path)}`
}

export async function fetchJsonFile<T>(token: string, path: string): Promise<{ data: T; sha: string } | null> {
  const res = await fetch(fileUrl(path), { headers: headers(token) })
  if (res.status === 404) return null
  if (res.status === 401) throw new Error('토큰이 유효하지 않습니다 (401)')
  if (!res.ok) throw new Error(`${path} 로드 실패 (${res.status})`)
  const json = await res.json()
  return { data: JSON.parse(b64decodeUtf8(json.content)) as T, sha: json.sha as string }
}

export async function putJsonFile(
  token: string,
  path: string,
  data: unknown,
  sha: string | null,
  message: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    message,
    content: b64encodeUtf8(JSON.stringify(data, null, 2) + '\n'),
  }
  if (sha) body.sha = sha
  const res = await fetch(fileUrl(path), {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (res.status === 409 || res.status === 422) throw new Error('충돌: 다른 곳에서 먼저 수정됨 — 재시도')
  if (!res.ok) throw new Error(`커밋 실패 (${res.status})`)
}

/* 텍스트 파일 갱신 (sha 낙관 잠금) — 취소 요청 등 REQ 파일 상태 전이용 */
export async function updateTextFile(
  token: string,
  path: string,
  transform: (text: string) => string,
  message: string,
): Promise<void> {
  const res = await fetch(fileUrl(path), { headers: apiHeaders(token) })
  if (!res.ok) throw new Error(`${path} 로드 실패 (${res.status})`)
  const json = await res.json()
  const next = transform(b64decodeUtf8(json.content))
  const put = await fetch(fileUrl(path), {
    method: 'PUT',
    headers: { ...apiHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: btoa(String.fromCharCode(...new TextEncoder().encode(next))), sha: json.sha }),
  })
  if (!put.ok) throw new Error(`갱신 실패 (${put.status})`)
}

export async function fetchTextFile(token: string, path: string): Promise<string> {
  const res = await fetch(fileUrl(path), { headers: headers(token) })
  if (res.status === 404) throw new Error('파일 없음 (404)')
  if (!res.ok) throw new Error(`${path} 로드 실패 (${res.status})`)
  const json = await res.json()
  return b64decodeUtf8(json.content)
}

/* ── 메일함: 러너가 동기화하는 inbox / 보드가 큐잉하는 outbox ── */

export interface InboxMessage {
  account: 'gmail' | 'naver'
  id: string
  at: number
  from: string
  to?: string
  subject: string
  snippet: string
  unread: boolean
  message_id?: string
  company?: string | null
  kind?: string | null
  body: string
  /* text/plain 파트가 없던 메일만: 서버측 새니타이즈된 HTML 원문 (40KB 캡) */
  html?: string
}
export interface InboxData {
  synced_at: string
  messages: InboxMessage[]
}

export interface OutboxItem {
  id: string
  account: string
  to: string
  subject: string
  body: string
  in_reply_to?: string
  status: 'queued' | 'sent' | 'failed'
  queued_at: string
  sent_at?: string
  error?: string
}
export interface OutboxData {
  items: OutboxItem[]
}

/* ── 러너 상태: 인증 콤보·요청 유형·최근 실행 (러너가 갱신) ── */

export interface RunnerModel {
  id: string
  label: string
  default?: boolean
}
export interface RunnerCombo {
  id: string
  provider: string
  auth: string
  label: string
  sdk: string
  capabilities: string[]
  models: RunnerModel[]
  ready: boolean
  reason?: string
  action?: string
}
export interface RequestType {
  id: string
  label: string
  needs: string
  cwd: string
}
export interface RunEvent {
  at: string
  type: string
  text: string
}
export interface RunnerRun {
  id: string
  status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
  started: string | null
  ended: string | null
  type: string
  combo: string | null
  model: string
  prompt: string
  session_id?: string
  events_tail?: RunEvent[]
  output?: string | null
  error?: string
}
export interface SdkCredit {
  month: string
  spent_usd: number
  runs: number
  judge_calls: number
  limit_usd: number | null
  note: string
}
export interface RunnerState {
  checked_at: string
  runner_alive_at: string
  combos: RunnerCombo[]
  request_types: RequestType[]
  recent_runs: RunnerRun[]
  sdk_credit?: SdkCredit
}

export async function createFile(
  token: string,
  path: string,
  content: string,
  message: string,
): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURI(path)}`, {
    method: 'PUT',
    headers: { ...headers(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: b64encodeUtf8(content) }),
  })
  if (!res.ok) throw new Error(`요청 생성 실패 (${res.status})`)
}

export type Notification = {
  id: string
  at: string
  source: string
  kind: string
  appId?: string | null
  company?: string | null
  subject: string
  statusChange?: string | null
  runId?: string | null
  handled: boolean
}

export interface NotifFile {
  schema?: number
  items: Notification[]
}

/* 읽음 처리(개별·일괄): 최신본을 다시 읽어 sha 충돌을 피하고 1커밋으로 기록 */
export async function markNotificationsRead(
  token: string,
  ids: 'all' | string[],
  user: string,
): Promise<void> {
  const fetched = await fetchJsonFile<NotifFile>(token, 'data/notifications.json')
  if (!fetched) return
  const items = fetched.data.items.map((n) =>
    ids === 'all' || ids.includes(n.id) ? { ...n, handled: true } : n,
  )
  await putJsonFile(
    token,
    'data/notifications.json',
    { schema: fetched.data.schema ?? 1, items },
    fetched.sha,
    `notifications: 읽음 ${ids === 'all' ? '전체' : `${ids.length}건`} (board:${user})`,
  )
}

export async function fetchDocBlobUrl(token: string, path: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURI(path)}`, {
    headers: headers(token),
  })
  if (!res.ok) throw new Error(`문서 로드 실패 (${res.status})`)
  const json = await res.json()
  const bin = atob((json.content as string).replace(/\n/g, ''))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  const mime = path.endsWith('.html')
    ? 'text/html'
    : path.endsWith('.pdf')
      ? 'application/pdf'
      : 'text/plain;charset=utf-8'
  return URL.createObjectURL(new Blob([bytes], { type: mime }))
}

export async function whoami(token: string): Promise<string> {
  const res = await fetch('https://api.github.com/user', { headers: headers(token) })
  if (!res.ok) return 'unknown'
  const json = await res.json()
  return json.login as string
}

import type { BoardData } from './types'
import { httpMode, cpReadState, cpWriteState, cpMe, API_BASE } from './backend'

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
  if (httpMode) {
    const r = await fetchJsonFile<BoardData>(token, PATH)
    if (!r) throw new Error('데이터 저장소 접근 불가 — 로그인 또는 데이터 이주를 확인하세요')
    return { data: r.data, sha: r.sha }
  }
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
  if (httpMode) return cpReadState<T>(token, path)
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
  if (httpMode) return cpWriteState(token, path, data)
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
  if (httpMode) {
    // 문서 프록시(#19): 세션 토큰엔 GitHub 권한 없음 → control-plane이 서버 토큰으로 대신 읽어 원문 반환
    const res = await fetch(`${API_BASE}/api/doc/${encodeURI(path)}`, { headers: { Authorization: `Bearer ${token}` } })
    if (res.status === 404) throw new Error('파일 없음 (404)')
    if (!res.ok) throw new Error(`${path} 로드 실패 (${res.status})`)
    return res.text()
  }
  const res = await fetch(fileUrl(path), { headers: headers(token) })
  if (res.status === 404) throw new Error('파일 없음 (404)')
  if (!res.ok) throw new Error(`${path} 로드 실패 (${res.status})`)
  const json = await res.json()
  return b64decodeUtf8(json.content)
}

/* 메일 읽음 요청 큐 — 보드 append, 러너가 메일 서버(Gmail UNREAD 제거 / Naver \Seen)에 반영.
   outbox와 같은 패턴(보드는 메일 서버 직접 접근 불가). 최신본 재취득 후 1커밋. */
export async function queueMailRead(token: string, account: string, id: string, user: string): Promise<void> {
  const path = 'data/mail/read-queue.json'
  const fetched = await fetchJsonFile<{ items: Array<{ account: string; id: string; at: string }> }>(token, path)
  const items = fetched?.data?.items ?? []
  if (items.some((x) => x.account === account && x.id === id)) return
  items.push({ account, id, at: new Date().toISOString() })
  await putJsonFile(token, path, { items: items.slice(-200) }, fetched?.sha ?? null,
    `mail: read ${account}:${id} (board:${user})`)
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

/* ── 메일 정규화 테이블 API (control-plane, httpMode 전용) ──────────────
   blob inbox.json 대신 mail_messages 를 커서 페이지네이션으로 읽는다. 서버가 relevance=recruiting
   필터링 — 보드는 채용 메일만 받는다. 목록은 경량(body 제외) → 본문은 열 때 mailGet 단건 조회. */
export interface MailFeedPage {
  messages: InboxMessage[]
  next_cursor: string | null
}

function cpBearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

export async function mailFeed(
  token: string,
  account?: string,
  cursor?: string | null,
  limit = 50,
): Promise<MailFeedPage> {
  const q = new URLSearchParams({ relevance: 'recruiting', limit: String(limit) })
  if (account) q.set('account', account)
  if (cursor) q.set('cursor', cursor)
  const res = await fetch(`${API_BASE}/api/mail?${q.toString()}`, { headers: cpBearer(token) })
  if (res.status === 401) throw new Error('세션이 만료되었습니다 (401)')
  if (!res.ok) throw new Error(`메일 로드 실패 (${res.status})`)
  return (await res.json()) as MailFeedPage
}

export async function mailGet(token: string, account: string, id: string): Promise<InboxMessage> {
  const res = await fetch(
    `${API_BASE}/api/mail/${encodeURIComponent(account)}/${encodeURIComponent(id)}`,
    { headers: cpBearer(token) },
  )
  if (!res.ok) throw new Error(`메일 본문 로드 실패 (${res.status})`)
  return (await res.json()) as InboxMessage
}

/* 읽음 — 서버 unread=0 즉시(기기 간 동기) + read-queue 적재(ingest 가 프로바이더 반영)를 서버가 처리. */
export async function mailMarkRead(token: string, account: string, id: string): Promise<void> {
  await fetch(
    `${API_BASE}/api/mail/${encodeURIComponent(account)}/${encodeURIComponent(id)}/read`,
    { method: 'POST', headers: cpBearer(token) },
  )
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

/* ── 메일 답장 초안: 러너가 mail-reply run 산출물을 메일 도메인 파일에 기록 ──
   account+id 키로 메일당 최신 1건. 보드는 reports/runs 경로 대신 이 파일을 단일 소스로 조회. */
export interface MailDraft {
  account: string
  id: string
  run_id: string
  body: string
  at: string
}
export interface MailDraftsData {
  items: MailDraft[]
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
  /* 멀티턴 묶음 키 — 같은 thread 의 run 들이 한 세션(누적 트랜스크립트). 없으면 run id 가 곧 thread. */
  thread?: string
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
  if (httpMode) {
    // 보드→러너 런 제출 브리지(#21): control-plane(bus_kv)에 REQ 적재 → 러너가 cp_list로 끌어가 처리.
    // GitHub API 직접 호출은 세션 토큰으로 401이라 httpMode에선 불가.
    await cpWriteState(token, path, { content, status: 'pending' })
    return
  }
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
  if (httpMode) {
    // 문서 프록시(#19): control-plane이 원문 바이트+content-type 반환 → 블롭 URL
    const res = await fetch(`${API_BASE}/api/doc/${encodeURI(path)}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!res.ok) throw new Error(`문서 로드 실패 (${res.status})`)
    return URL.createObjectURL(await res.blob())
  }
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

/* 클라우드 산출물(생성 PDF 등 git 밖) — control-plane DB(테넌트 스코프)에서 조회. httpMode 전용. */
export async function fetchArtifactBlobUrl(token: string, path: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/artifact/${encodeURI(path)}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`산출물 로드 실패 (${res.status})`)
  return URL.createObjectURL(await res.blob())
}

export async function whoami(token: string): Promise<string> {
  if (httpMode) return cpMe(token)
  const res = await fetch('https://api.github.com/user', { headers: headers(token) })
  if (!res.ok) return 'unknown'
  const json = await res.json()
  return json.login as string
}

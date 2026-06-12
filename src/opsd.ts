/* opsd — 로컬 데몬(127.0.0.1:8787) 클라이언트.
   메일·알림·에이전트 실행은 전부 데몬 경유. 자격증명은 브라우저 번들로 들어오지 않는다.
   기동 감지 = GET /health (무인증, 1.5s 타임아웃). 실패 시 보드는 큐 모드로 동작한다. */

export const OPSD_BASE = 'http://127.0.0.1:8787'
export const DAEMON_TOKEN_KEY = 'careerDaemonToken'
const PROVIDERS_CACHE_KEY = 'careerProvidersCache'

export function getDaemonToken(): string | null {
  return localStorage.getItem(DAEMON_TOKEN_KEY)
}
export function setDaemonToken(t: string): void {
  localStorage.setItem(DAEMON_TOKEN_KEY, t)
}

export async function checkDaemonHealth(): Promise<boolean> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), 1500)
  try {
    const res = await fetch(`${OPSD_BASE}/health`, { signal: ctrl.signal })
    if (!res.ok) return false
    const json = (await res.json()) as { ok?: boolean }
    return json.ok === true
  } catch {
    return false
  } finally {
    window.clearTimeout(timer)
  }
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

async function opsdGet<T>(token: string, path: string): Promise<T> {
  const res = await fetch(`${OPSD_BASE}${path}`, { headers: authHeaders(token) })
  if (res.status === 401) throw new Error('데몬 토큰이 유효하지 않습니다 (401)')
  if (!res.ok) throw new Error(`데몬 요청 실패 (${res.status})`)
  return (await res.json()) as T
}

async function opsdPost<T>(token: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${OPSD_BASE}${path}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 401) throw new Error('데몬 토큰이 유효하지 않습니다 (401)')
  if (!res.ok) throw new Error(`데몬 요청 실패 (${res.status})`)
  return (await res.json()) as T
}

/* ── providers ── */

export interface ProviderModel {
  id: string
  label: string
  default?: boolean
}
export interface ProviderCombo {
  id: string
  provider: string
  auth: string
  label: string
  sdk: string
  ready: boolean
  reason?: string
  capabilities: Array<'files' | 'research'>
  models: ProviderModel[]
}
export interface RequestType {
  id: string
  label: string
  needs: string
  cwd: string
}
export interface ProvidersPayload {
  combos: ProviderCombo[]
  request_types: RequestType[]
}

export async function fetchProviders(token: string): Promise<ProvidersPayload> {
  const payload = await opsdGet<ProvidersPayload>(token, '/providers')
  try {
    localStorage.setItem(PROVIDERS_CACHE_KEY, JSON.stringify(payload))
  } catch {
    /* 캐시 실패는 무시 */
  }
  return payload
}

/* 큐 모드(데몬 오프라인)에서 마지막으로 본 카탈로그 — runner 블록 작성용 */
export function cachedProviders(): ProvidersPayload | null {
  try {
    const raw = localStorage.getItem(PROVIDERS_CACHE_KEY)
    return raw ? (JSON.parse(raw) as ProvidersPayload) : null
  } catch {
    return null
  }
}

/* ── mail ── */

export interface MailListItem {
  account: 'gmail' | 'naver'
  id: string
  at: number
  from: string
  subject: string
  snippet: string
  unread: boolean
  thread_id: string | null
}
export interface MailListResult {
  messages: MailListItem[]
  errors: { gmail?: string; naver?: string }
}
export interface MailMessage {
  account: 'gmail' | 'naver'
  id: string
  at: number
  from: string
  to: string
  subject: string
  message_id: string
  thread_id: string | null
  text: string
  html: string
}

export async function mailList(token: string, limit = 25): Promise<MailListResult> {
  return opsdGet<MailListResult>(token, `/mail/list?limit=${limit}`)
}

export async function mailMessage(token: string, account: string, id: string): Promise<MailMessage> {
  return opsdGet<MailMessage>(token, `/mail/message?account=${encodeURIComponent(account)}&id=${encodeURIComponent(id)}`)
}

export async function mailSend(
  token: string,
  body: { account: string; to: string; subject: string; body: string; in_reply_to?: string; thread_id?: string },
): Promise<{ ok: boolean; id: string }> {
  return opsdPost(token, '/mail/send', body)
}

export async function mailScan(token: string): Promise<{ ok: boolean; new_notifications: number }> {
  return opsdPost(token, '/mail/scan')
}

/* ── notifications (라이브 모드) ── */

export interface OpsdNotification {
  id: string
  at: string
  source: string
  kind: string
  subject: string
  company?: string | null
  statusChange?: string | null
  runId?: string | null
  handled: boolean
}

export async function notifList(token: string): Promise<OpsdNotification[]> {
  const json = await opsdGet<{ items: OpsdNotification[] }>(token, '/notifications')
  return json.items ?? []
}

export async function notifRead(token: string, ids?: string[]): Promise<void> {
  await opsdPost(token, '/notifications/read', ids ? { ids } : {})
}

/* ── runs ── */

export interface RunSummary {
  id: string
  status: 'running' | 'done' | 'failed'
  started: string | null
  ended: string | null
  type: string
  provider: string
  auth: string
  model: string
  prompt: string
}
export interface RunEvent {
  at: string
  type: string
  text: string
}
export interface RunDetail {
  id: string
  spec: { type: string; provider: string; auth: string; model: string; prompt: string }
  status: 'running' | 'done' | 'failed'
  started: string | null
  ended: string | null
  exit?: number
  events_tail: RunEvent[]
  result?: string
}

export async function runsList(token: string): Promise<RunSummary[]> {
  const json = await opsdGet<{ runs: RunSummary[] }>(token, '/runs')
  return json.runs ?? []
}

export async function runCreate(
  token: string,
  spec: { type: string; provider: string; auth: string; model: string; prompt: string },
): Promise<string> {
  const json = await opsdPost<{ ok: boolean; id: string }>(token, '/runs', spec)
  return json.id
}

export async function runDetail(token: string, id: string): Promise<RunDetail> {
  return opsdGet<RunDetail>(token, `/runs/${encodeURIComponent(id)}`)
}

export async function runStop(token: string, id: string): Promise<void> {
  await opsdPost(token, `/runs/${encodeURIComponent(id)}/stop`)
}

/* SWR 캐시 (SPEC §7.5): 인증 직후 5개 데이터원 병렬 prefetch →
   메모리 스토어 + localStorage 영속. 뷰 전환은 캐시 즉시 렌더만.
   백그라운드 재검증은 GitHub API ETag(If-None-Match) 조건부 요청으로 304 절감. */
import { useSyncExternalStore } from 'react'
import { apiHeaders, b64decodeUtf8, fileUrl } from './api'

export type StoreKey = 'applications' | 'notifications' | 'inbox' | 'runner-state' | 'outbox'

export const STORE_PATH: Record<StoreKey, string> = {
  applications: 'data/applications.json',
  notifications: 'data/notifications.json',
  inbox: 'data/mail/inbox.json',
  'runner-state': 'data/runner-state.json',
  outbox: 'data/mail/outbox.json',
}

export interface Entry<T> {
  data: T | null
  sha: string | null
  etag: string | null
  at: number
  missing: boolean
}

const CACHE_PREFIX = 'career-board:cache:'
const mem = new Map<StoreKey, Entry<unknown>>()
const listeners = new Set<() => void>()

/* 시작 시 localStorage 캐시 하이드레이트 — 캐시가 있으면 첫 렌더부터 데이터 */
for (const key of Object.keys(STORE_PATH) as StoreKey[]) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    if (raw) mem.set(key, JSON.parse(raw) as Entry<unknown>)
  } catch {
    localStorage.removeItem(CACHE_PREFIX + key)
  }
}

function emit(): void {
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useEntry<T>(key: StoreKey): Entry<T> | undefined {
  return useSyncExternalStore(subscribe, () => mem.get(key) as Entry<T> | undefined)
}

function setEntry<T>(key: StoreKey, entry: Entry<T>): void {
  mem.set(key, entry as Entry<unknown>)
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry))
  } catch {
    /* 저장 실패(쿼터 등)는 메모리 캐시로 충분 */
  }
  emit()
}

/* 낙관적 갱신: 커밋 성공 직후 자리 교체. etag 를 비워 다음 재검증은 무조건 200 */
export function patchEntry<T>(key: StoreKey, data: T, sha: string | null): void {
  const cur = mem.get(key)
  setEntry(key, { data, sha: sha ?? cur?.sha ?? null, etag: null, at: Date.now(), missing: false })
}

export function clearStore(): void {
  for (const key of Object.keys(STORE_PATH) as StoreKey[]) localStorage.removeItem(CACHE_PREFIX + key)
  mem.clear()
  emit()
}

/* 조건부 재검증: 304 면 캐시 유지(재렌더 없음), 200 이면 자리 교체 */
export async function revalidate(token: string, key: StoreKey): Promise<void> {
  const cur = mem.get(key)
  const headers: Record<string, string> = { ...apiHeaders(token) }
  if (cur?.etag) headers['If-None-Match'] = cur.etag
  const res = await fetch(fileUrl(STORE_PATH[key]), { headers })
  if (res.status === 304) return
  if (res.status === 404) {
    setEntry(key, { data: null, sha: null, etag: null, at: Date.now(), missing: true })
    return
  }
  if (res.status === 401) throw new Error('토큰이 유효하지 않습니다 (401)')
  if (!res.ok) throw new Error(`${STORE_PATH[key]} 로드 실패 (${res.status})`)
  const json = await res.json()
  setEntry(key, {
    data: JSON.parse(b64decodeUtf8(json.content as string)),
    sha: json.sha as string,
    etag: res.headers.get('ETag'),
    at: Date.now(),
    missing: false,
  })
}

/* 인증 직후 5개 파일 병렬 prefetch. applications 실패는 인증 실패로 승격 */
export async function prefetchAll(token: string): Promise<void> {
  const keys = Object.keys(STORE_PATH) as StoreKey[]
  const results = await Promise.allSettled(keys.map((k) => revalidate(token, k)))
  const appResult = results[keys.indexOf('applications')]
  if (appResult.status === 'rejected') throw appResult.reason
  if (mem.get('applications')?.missing) {
    throw new Error('데이터 저장소 접근 불가 (404) — 토큰 권한을 확인하세요')
  }
}

/* 메일 읽음 오버레이 — localStorage 영속 Set<`${account}:${id}`>.
 * 서버 sync 보다 우선: 한 번 읽으면 inbox 재검증이 unread=true 로 와도 회색을 유지한다.
 * 러너가 메일 서버에 반영을 마쳐 sync 가 unread=false 로 오면 정합 — 그때 키를 정리(영구 증식 방지). */
import { useSyncExternalStore } from 'react'

const KEY = 'career-board:mail-read'
const listeners = new Set<() => void>()
let set: Set<string> = load()
/* 스냅샷 안정성(useSyncExternalStore 무한 루프 방지): 변경 시에만 새 배열 */
let snapshot: string[] = [...set]

function load(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) return new Set(JSON.parse(raw) as string[])
  } catch {
    localStorage.removeItem(KEY)
  }
  return new Set()
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]))
  } catch {
    /* 쿼터 등 저장 실패는 메모리 Set 으로 충분 */
  }
  snapshot = [...set]
  for (const l of listeners) l()
}

export function mailReadKey(account: string, id: string): string {
  return `${account}:${id}`
}

export function markMailRead(account: string, id: string): void {
  const k = mailReadKey(account, id)
  if (set.has(k)) return
  set.add(k)
  persist()
}

/* sync 가 unread=false 로 확정한 키는 오버레이에서 제거 — 서버와 정합되면 더 가릴 필요가 없다 */
export function pruneMailRead(stillUnreadKeys: Set<string>): void {
  let changed = false
  for (const k of set) {
    if (!stillUnreadKeys.has(k)) {
      set.delete(k)
      changed = true
    }
  }
  if (changed) persist()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/* 오버레이 키 배열(안정 스냅샷). 호출부는 useMemo 로 Set 화하여 has() 조회 */
export function useMailReadOverlay(): string[] {
  return useSyncExternalStore(subscribe, () => snapshot)
}

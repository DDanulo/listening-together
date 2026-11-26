import { useEffect, useState, useSyncExternalStore } from 'react'
import type { RoomSession, RoomView } from '../session/types'

export function useRoom(session: RoomSession): RoomView {
  return useSyncExternalStore(session.subscribe, session.getSnapshot)
}

/** Re-renders every `intervalMs`, for values read live from the session (position, countdowns). */
export function useTicker(intervalMs: number): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
}

/** performance.now(), refreshed every `intervalMs` (render must not read the clock itself). */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => performance.now())
  useEffect(() => {
    const id = window.setInterval(() => setNow(performance.now()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}

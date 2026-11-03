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

// Reconnection policy (docs/protocol.md §3.2). Pure, so it can be unit-tested.

import { CloseCode } from '../protocol/types'

/** 0.5 s, 1 s, 2 s, 4 s, then every 8 s. */
const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000]

/** Delay before reconnect attempt number `attempt` (0 = the first attempt after a disconnect). */
export function backoffDelayMs(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(0, attempt), BACKOFF_MS.length - 1)]
}

/** Closes after which reconnecting can't help: the user left, or the server refused us for good. */
const FINAL_CLOSES = new Set<number>([
  CloseCode.NORMAL, CloseCode.PROTOCOL_ERROR, CloseCode.ROOM_NOT_FOUND, CloseCode.ROOM_FULL, CloseCode.RATE_LIMITED,
])

export function shouldReconnect(closeCode: number): boolean {
  return !FINAL_CLOSES.has(closeCode)
}

/**
 * A ping unanswered for this long means the connection is dead even if the browser hasn't noticed: after a network
 * switch a socket can stay "open" for minutes. Pings go out every 5 s, so this tolerates one lost round of them.
 */
export const LIVENESS_TIMEOUT_MS = 8_000

/**
 * @param oldestUnansweredPingAt client time of the oldest ping sent since the last pong, or null if none is
 *        outstanding. Measuring from the ping (not from the last pong) keeps background tabs, whose timers the
 *        browser throttles to once a minute, from looking dead.
 */
export function looksDead(oldestUnansweredPingAt: number | null, clientNow: number): boolean {
  return oldestUnansweredPingAt !== null && clientNow - oldestUnansweredPingAt > LIVENESS_TIMEOUT_MS
}

// Playback planning — see docs/protocol.md §5. Pure: all times are server time in ms.

import type { PlaybackState } from '../protocol/types'

/** Minimum time between planning and an audio start, so Web Audio can schedule it precisely. */
export const SCHEDULE_MARGIN_MS = 30

/** Expected track position at `serverTime` under `state` (not clamped to the track duration). */
export function expectedPosition(state: PlaybackState, serverTime: number): number {
  return state.status === 'playing' ? state.position + (serverTime - state.effectiveAt) : state.position
}

/** A piece of audio that is scheduled or playing. */
export interface Segment {
  /** Revision of the state that created it. */
  rev: number
  trackId: string
  /** Server time at which the audio starts. */
  startAt: number
  /** Track position (ms) at `startAt`. */
  position: number
  /** Server time at which it is scheduled to stop; null = until the end of the track. */
  stopAt: number | null
}

export interface Plan {
  /** Segments that would start at or after the change: never let them play. */
  cancel: Segment[]
  /** Segments that are (or will be) playing before the change: stop them exactly at `at`. */
  stop: { segment: Segment; at: number }[]
  /** New audio for a playing state; null if nothing should play. */
  start: { rev: number; trackId: string; startAt: number; position: number } | null
}

/**
 * Plans the audio changes for `state`. The previous state keeps applying until `state.effectiveAt`, so audio
 * scheduled before that moment is stopped at `effectiveAt`, not cancelled. A state whose `effectiveAt` has passed
 * (late message, late join) starts immediately at the position it would have by now.
 */
export function planTransition(
  segments: readonly Segment[],
  state: PlaybackState,
  serverNow: number,
  durationMs: number | null,
): Plan {
  const plan: Plan = { cancel: [], stop: [], start: null }
  const at = state.effectiveAt

  for (const segment of segments) {
    if (segment.rev >= state.rev) continue // already created for this state
    if (segment.startAt >= at) {
      plan.cancel.push(segment)
    } else if (segment.stopAt === null || segment.stopAt > at) {
      plan.stop.push({ segment, at })
    }
  }

  const alreadyStarted = segments.some((s) => s.rev === state.rev)
  if (state.status === 'playing' && state.trackId !== null && !alreadyStarted) {
    const startAt = Math.max(at, serverNow + SCHEDULE_MARGIN_MS)
    const position = expectedPosition(state, startAt)
    if (durationMs === null || position < durationMs) {
      plan.start = { rev: state.rev, trackId: state.trackId, startAt, position }
    }
  }
  return plan
}

/** Position of the segment audible at `serverNow`, or null if nothing is playing. */
export function audiblePosition(segments: readonly Segment[], serverNow: number): number | null {
  const segment = segments.find(
    (s) => s.startAt <= serverNow && (s.stopAt === null || serverNow < s.stopAt),
  )
  return segment ? segment.position + (serverNow - segment.startAt) : null
}

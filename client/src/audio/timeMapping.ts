// Converting between the client clock (performance.now(), ms) and the AudioContext clock (seconds).
// Pure, so it can be tested without an AudioContext.

/** Simultaneous readings of both clocks, e.g. from AudioContext.getOutputTimestamp(). */
export interface AudioClockPair {
  /** AudioContext time in seconds. */
  contextTime: number
  /** performance.now() in ms at the same moment. */
  performanceTime: number
}

export function clientToAudioTime(clientTime: number, pair: AudioClockPair): number {
  return pair.contextTime + (clientTime - pair.performanceTime) / 1000
}

export function serverToClientTime(serverTime: number, offset: number): number {
  return serverTime - offset
}

export function audioToClientTime(audioTime: number, pair: AudioClockPair): number {
  return pair.performanceTime + (audioTime - pair.contextTime) * 1000
}

/** Older readings are treated as stale, e.g. after the audio output went idle during a long pause. */
export const MAX_TIMESTAMP_AGE_MS = 250

/** Whether a getOutputTimestamp() reading taken at `clientNow` still describes the running output. */
export function isFresh(pair: AudioClockPair, clientNow: number): boolean {
  return pair.performanceTime > 0 && Math.abs(clientNow - pair.performanceTime) <= MAX_TIMESTAMP_AGE_MS
}

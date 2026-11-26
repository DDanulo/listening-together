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

/** From `audioTime` (AudioContext s) on, the source plays the track from `position` (ms) at `rate`. */
export interface RateAnchor {
  audioTime: number
  position: number
  rate: number
}

/** Track position (ms) a source plays at `audioTime`, given its rate changes (oldest first, non-empty). */
export function positionAtAudioTime(anchors: readonly RateAnchor[], audioTime: number): number {
  let anchor = anchors[0]
  for (const candidate of anchors) {
    if (candidate.audioTime <= audioTime) anchor = candidate
  }
  return anchor.position + (audioTime - anchor.audioTime) * 1000 * anchor.rate
}

/**
 * How far a playing source is behind where it should be (ms; negative = ahead), at the moment described by
 * `pair` (a fresh output timestamp: the sound leaving the speaker now).
 *
 * @param segment server time `startAt` at which the track should be at `position`; it then advances in real time
 * @param offset serverTime − clientTime
 */
export function positionErrorMs(
  segment: { startAt: number; position: number },
  anchors: readonly RateAnchor[],
  pair: AudioClockPair,
  offset: number,
): number {
  const serverNow = pair.performanceTime + offset
  const expected = segment.position + (serverNow - segment.startAt)
  return expected - positionAtAudioTime(anchors, pair.contextTime)
}

/** Earliest start handed to Web Audio, ahead of its clock: a start in the past would play from the wrong position. */
export const MIN_START_LEAD_S = 0.02

/**
 * Moves a start that is already too close (or past) on the audio clock to `earliest`, advancing the track position
 * by the same amount (rule 6). Without this, Web Audio starts a past `when` immediately but from the *planned*
 * position, so the audio is late by however far `when` was in the past: with the output-timestamp mapping that is
 * up to the whole output latency (tens of ms; ~200 ms on Bluetooth), on every late join and resync.
 *
 * @param when planned start, AudioContext seconds
 * @param position track position (ms) planned for `when`
 * @param earliest earliest acceptable start, AudioContext seconds
 */
export function catchUpStart(when: number, position: number, earliest: number): { when: number; position: number } {
  return when >= earliest ? { when, position } : { when: earliest, position: position + (earliest - when) * 1000 }
}

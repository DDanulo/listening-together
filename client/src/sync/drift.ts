// Drift correction (evaluation E3 compares the strategies). Pure: works on measured position errors in ms,
// positive = this device is behind (plays an earlier part of the track than it should).

/**
 * - `off`: measure only (the E3 baseline: how far playback drifts on its own).
 * - `resync`: restart playback at the right position when the error gets too big (audible skip, but instant).
 * - `nudge`: speed playback up or down by a fraction of a percent until it's aligned (inaudible, but gradual);
 *   restart only for errors too big to nudge away.
 */
export type DriftStrategy = 'off' | 'resync' | 'nudge'

export const DRIFT_STRATEGIES: readonly DriftStrategy[] = ['off', 'resync', 'nudge']

/** `resync`: a playing segment further off than this is restarted at the correct position. */
export const RESYNC_THRESHOLD_MS = 20
/** Minimum time between resyncs, so a noisy measurement can't cause a restart loop. */
export const RESYNC_COOLDOWN_MS = 3_000

/** `nudge`: errors below this are left alone. */
export const NUDGE_START_MS = 3
/** `nudge`: once nudging, keep going until the error is this small (hysteresis, so it doesn't flap). */
export const NUDGE_STOP_MS = 1
/** `nudge`: above this, nudging would take too long (50 ms at the max rate ≈ 17 s): restart instead. */
export const NUDGE_MAX_ERROR_MS = 50
/** `nudge`: the rate is chosen to remove the error in about this time (a proportional controller). */
export const NUDGE_CORRECTION_TIME_MS = 10_000
/**
 * `nudge`: largest rate change, ±0.3 % (about 5 cents of pitch: Web Audio buffer sources can't preserve pitch, and
 * people start noticing at around 5–10 cents). Corrects up to 3 ms per second.
 */
export const NUDGE_MAX_RATE_DEVIATION = 0.003
/**
 * `nudge`: readings averaged per decision. A single reading is noisy (the output clock is read in steps of the audio
 * output's buffer: std ≈ 1.5 ms on Chrome/Linux); the trimmed mean of 8 gets that to ≈ 0.5 ms.
 */
export const NUDGE_READINGS = 8

/** One timing measurement of the playing segment. */
export interface Reading {
  /** Position error when it was measured. */
  errorMs: number
  /**
   * How far nudging had moved the audio (ms of track gained, ahead of normal speed) up to that moment. Knowing it,
   * old readings can be projected to now, so averaging them adds no lag.
   */
  nudgedMs: number
}

export type Correction = { kind: 'none' } | { kind: 'rate'; rate: number } | { kind: 'resync' }

const NONE: Correction = { kind: 'none' }

/**
 * Restart only when two consecutive measurements agree that playback is off in the same direction: a single
 * outlier (e.g. while the audio output is still waking up) must not restart the audio.
 *
 * @param errorMs latest position error
 * @param previousErrorMs the measurement before, or null if there is none since the last resync
 * @param msSinceLastResync time since the previous resync (Infinity if none)
 */
export function needsResync(
  errorMs: number,
  previousErrorMs: number | null,
  msSinceLastResync: number,
  thresholdMs = RESYNC_THRESHOLD_MS,
): boolean {
  if (previousErrorMs === null || msSinceLastResync < RESYNC_COOLDOWN_MS) return false
  const confirmed = Math.sign(errorMs) === Math.sign(previousErrorMs)
  return confirmed && Math.abs(errorMs) > thresholdMs && Math.abs(previousErrorMs) > thresholdMs
}

/**
 * The current position error from recent readings: each is projected to now by taking out the nudging done since
 * it was measured, then averaged without the extremes. Null without readings.
 *
 * @param nudgedNowMs `Reading.nudgedMs` as of now
 */
export function estimateErrorMs(readings: readonly Reading[], nudgedNowMs: number): number | null {
  const recent = readings.slice(-NUDGE_READINGS)
  if (recent.length === 0) return null
  // Nudging ahead by n ms reduces the error by n ms.
  const projected = recent.map((r) => r.errorMs - (nudgedNowMs - r.nudgedMs)).sort((a, b) => a - b)
  const trimmed = projected.length >= 5 ? projected.slice(1, -1) : projected
  return trimmed.reduce((sum, e) => sum + e, 0) / trimmed.length
}

/**
 * Decides what to do about the playing segment's timing.
 *
 * @param readings measurements of the current segment since its start or last resync, oldest first
 * @param currentRate the segment's playback rate now (1 = normal speed)
 * @param nudgedNowMs how far nudging has moved the segment's audio so far (see `Reading.nudgedMs`)
 * @param msSinceLastResync time since the previous resync (Infinity if none)
 */
export function decideCorrection(
  strategy: DriftStrategy,
  readings: readonly Reading[],
  currentRate: number,
  nudgedNowMs: number,
  msSinceLastResync: number,
): Correction {
  if (strategy === 'off' || readings.length === 0) return NONE
  const latest = readings[readings.length - 1].errorMs
  const previous = readings.length > 1 ? readings[readings.length - 2].errorMs : null

  if (strategy === 'resync') {
    return needsResync(latest, previous, msSinceLastResync) ? { kind: 'resync' } : NONE
  }

  if (needsResync(latest, previous, msSinceLastResync, NUDGE_MAX_ERROR_MS)) return { kind: 'resync' }
  // A few readings before the first decision: one or two can't be told apart from noise.
  if (readings.length < 3) return NONE
  const error = estimateErrorMs(readings, nudgedNowMs) as number
  const nudging = currentRate !== 1
  if (Math.abs(error) < (nudging ? NUDGE_STOP_MS : NUDGE_START_MS)) {
    return nudging ? { kind: 'rate', rate: 1 } : NONE
  }
  const rate = nudgeRate(error)
  // Tiny changes aren't worth an audio-graph update; they're below what the measurement can tell apart.
  return Math.abs(rate - currentRate) < 1e-5 ? NONE : { kind: 'rate', rate }
}

/** Playback rate that removes `errorMs` in about NUDGE_CORRECTION_TIME_MS, within the allowed deviation. */
export function nudgeRate(errorMs: number): number {
  const deviation = errorMs / NUDGE_CORRECTION_TIME_MS
  const clamped = Math.max(-NUDGE_MAX_RATE_DEVIATION, Math.min(NUDGE_MAX_RATE_DEVIATION, deviation))
  // Rounded so repeated decisions on similar errors produce the same value.
  return Math.round((1 + clamped) * 1e5) / 1e5
}

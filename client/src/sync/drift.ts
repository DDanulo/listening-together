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

/** `nudge`: errors below this are left alone (measurement noise is a few ms). */
export const NUDGE_START_MS = 5
/** `nudge`: once nudging, keep going until the error is this small (hysteresis, so it doesn't flap at 5 ms). */
export const NUDGE_STOP_MS = 2
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
 * Readings combined (median) per decision. The output clock is read in steps of the audio output's buffer, so
 * single readings jump by a few ms (seen: ±3 ms on Chrome/Linux); a median of 5 keeps that noise from moving the
 * rate, and still reacts within 3 s to a real error.
 */
export const NUDGE_READINGS = 5

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
 * Decides what to do about the playing segment's timing.
 *
 * @param readings position errors of the current segment since its start or last resync, oldest first
 * @param currentRate the segment's playback rate now (1 = normal speed)
 * @param msSinceLastResync time since the previous resync (Infinity if none)
 */
export function decideCorrection(
  strategy: DriftStrategy,
  readings: readonly number[],
  currentRate: number,
  msSinceLastResync: number,
): Correction {
  if (strategy === 'off' || readings.length === 0) return NONE
  const latest = readings[readings.length - 1]
  const previous = readings.length > 1 ? readings[readings.length - 2] : null

  if (strategy === 'resync') {
    return needsResync(latest, previous, msSinceLastResync) ? { kind: 'resync' } : NONE
  }

  if (needsResync(latest, previous, msSinceLastResync, NUDGE_MAX_ERROR_MS)) return { kind: 'resync' }
  if (readings.length < 2) return NONE
  const error = median(readings.slice(-NUDGE_READINGS))
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

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

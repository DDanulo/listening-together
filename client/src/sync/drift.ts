// Drift detection — hard-resync variant (evaluation E3 compares it with playback-rate nudging later).

/** A playing segment further off than this is restarted at the correct position. */
export const RESYNC_THRESHOLD_MS = 20
/** Minimum time between resyncs, so a noisy measurement can't cause a restart loop. */
export const RESYNC_COOLDOWN_MS = 3_000

/**
 * Resync only when two consecutive measurements agree that playback is off in the same direction: a single
 * outlier (e.g. while the audio output is still waking up) must not restart the audio.
 *
 * @param errorMs actual − intended output time of the playing audio (positive = this device is behind)
 * @param previousErrorMs the measurement before, or null if there is none since the last resync
 * @param msSinceLastResync time since the previous resync (Infinity if none)
 */
export function needsResync(errorMs: number, previousErrorMs: number | null, msSinceLastResync: number): boolean {
  if (previousErrorMs === null || msSinceLastResync < RESYNC_COOLDOWN_MS) return false
  const confirmed = Math.sign(errorMs) === Math.sign(previousErrorMs)
  return confirmed && Math.abs(errorMs) > RESYNC_THRESHOLD_MS && Math.abs(previousErrorMs) > RESYNC_THRESHOLD_MS
}

import type { SessionOptions } from '../session/session'
import { DRIFT_STRATEGIES, type DriftStrategy } from '../sync/drift'

/**
 * Evaluation switches from the room URL, e.g. `/r/k3x9qa?drift=resync`. Unknown values fall back to the defaults,
 * so a typo never breaks a room for a real listener.
 */
export function experimentOptions(search: string): SessionOptions {
  const params = new URLSearchParams(search)
  const drift = params.get('drift')
  return {
    naive: params.has('naive'),
    drift: DRIFT_STRATEGIES.includes(drift as DriftStrategy) ? (drift as DriftStrategy) : undefined,
  }
}

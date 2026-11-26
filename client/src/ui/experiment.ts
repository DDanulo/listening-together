import type { EvalChannel } from '../protocol/types'
import type { SessionOptions } from '../session/session'
import { CLOCK_STRATEGIES } from '../sync/clock'
import { DRIFT_STRATEGIES } from '../sync/drift'

const EVAL_CHANNELS: readonly EvalChannel[] = ['1', '2', '3', 'all']

/**
 * Evaluation switches from the room URL, e.g. `/r/k3x9qa?clock=single&drift=off&evalChannel=2` (eval/RUNBOOK.md).
 * Unknown values fall back to the defaults, so a typo never breaks a room for a real listener.
 */
export function experimentOptions(search: string): SessionOptions {
  const params = new URLSearchParams(search)
  return {
    naive: params.has('naive'),
    drift: oneOf(DRIFT_STRATEGIES, params.get('drift')),
    clock: oneOf(CLOCK_STRATEGIES, params.get('clock')),
    evalChannel: oneOf(EVAL_CHANNELS, params.get('evalChannel')),
  }
}

function oneOf<T extends string>(allowed: readonly T[], value: string | null): T | undefined {
  return allowed.find((candidate) => candidate === value)
}

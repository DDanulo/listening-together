const KEY = 'listening-together.clientId'

/** Also kept in memory: without sessionStorage (e.g. blocked), reconnects must still reuse the same id. */
let current: string | null = null

/** One id per browser tab (protocol §3.2); it survives reloads and reconnects. */
export function clientId(): string {
  if (current) return current
  try {
    current = sessionStorage.getItem(KEY)
  } catch {
    // storage blocked: the id lives only as long as this page
  }
  if (!current) store(randomId())
  return current as string
}

/**
 * Replaces this tab's id. Used after close 4410: a duplicated tab inherits sessionStorage, so two tabs end up with
 * the same id and would keep taking the member from each other.
 */
export function resetClientId(): void {
  store(randomId())
}

function store(id: string): void {
  current = id
  try {
    sessionStorage.setItem(KEY, id)
  } catch {
    // see clientId()
  }
}

function randomId(): string {
  // crypto.randomUUID only exists in secure contexts; LAN testing over plain http needs the fallback.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

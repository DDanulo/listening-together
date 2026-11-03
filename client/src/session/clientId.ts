const KEY = 'listening-together.clientId'

/** One id per browser tab (protocol §3.2). */
export function clientId(): string {
  try {
    const existing = sessionStorage.getItem(KEY)
    if (existing) return existing
    const id = randomId()
    sessionStorage.setItem(KEY, id)
    return id
  } catch {
    return randomId()
  }
}

function randomId(): string {
  // crypto.randomUUID only exists in secure contexts; LAN testing over plain http needs the fallback.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
}

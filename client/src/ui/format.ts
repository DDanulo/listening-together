export function formatTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '–:––'
  const totalSeconds = Math.floor(ms / 1000)
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, '0')}`
}

export function formatMs(ms: number | null | undefined, digits = 1): string {
  return ms == null ? '–' : `${ms.toFixed(digits)} ms`
}

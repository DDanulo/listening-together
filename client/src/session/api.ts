import type { Track } from '../protocol/types'

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { code?: string; message?: string } | null
    throw new ApiError(body?.code ?? `HTTP_${response.status}`, body?.message ?? response.statusText,
      response.status)
  }
  return (await response.json()) as T
}

export function createRoom(): Promise<{ roomId: string }> {
  return request('/api/rooms', { method: 'POST' })
}

export function getRoom(roomId: string): Promise<{ roomId: string; memberCount: number }> {
  return request(`/api/rooms/${encodeURIComponent(roomId)}`)
}

export function uploadTrack(roomId: string, memberId: string, file: File, durationMs: number): Promise<Track> {
  const form = new FormData()
  form.append('file', file)
  form.append('durationMs', String(durationMs))
  form.append('memberId', memberId)
  return request(`/api/rooms/${encodeURIComponent(roomId)}/tracks`, { method: 'POST', body: form })
}

/** Duration from the file's metadata, without decoding the whole file. NaN if the browser can't tell. */
export function readDurationMs(file: File): Promise<number> {
  return new Promise((resolve) => {
    const audio = new Audio()
    const url = URL.createObjectURL(file)
    const done = (durationMs: number) => {
      URL.revokeObjectURL(url)
      resolve(durationMs)
    }
    audio.preload = 'metadata'
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration * 1000 : NaN)
    audio.onerror = () => done(NaN)
    audio.src = url
  })
}

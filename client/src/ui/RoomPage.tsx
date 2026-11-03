import { type FormEvent, useEffect, useMemo, useState } from 'react'
import { ApiError, getRoom } from '../session/api'
import { LiveRoomSession } from '../session/session'
import { RoomScreen } from './RoomScreen'
import { useRoom } from './useRoom'

const NAME_KEY = 'listening-together.name'

export function RoomPage({ roomId }: { roomId: string }) {
  const [exists, setExists] = useState<'checking' | 'yes' | 'no' | 'error'>('checking')
  const session = useMemo(
    () => new LiveRoomSession(roomId, { naive: new URLSearchParams(location.search).has('naive') }),
    [roomId],
  )
  const view = useRoom(session)

  useEffect(() => {
    getRoom(roomId).then(
      () => setExists('yes'),
      (e: unknown) => setExists(e instanceof ApiError && e.status === 404 ? 'no' : 'error'),
    )
  }, [roomId])
  useEffect(() => () => session.leave(), [session])

  if (exists === 'checking') return <main className="page"><p className="muted">Loading…</p></main>
  if (exists === 'no' || view.error?.code === 'ROOM_NOT_FOUND') {
    return (
      <main className="page">
        <h1>Room not found</h1>
        <p className="muted">The room <code>{roomId}</code> doesn't exist (anymore).</p>
        <a href="/">Create a new room</a>
      </main>
    )
  }
  if (exists === 'error') return <main className="page"><p className="error">Could not reach the server.</p></main>
  if (view.me === null) {
    return <JoinForm onJoin={(name) => session.join(name)} connecting={view.connection === 'connecting'}
      error={view.error?.message ?? null} />
  }
  return <RoomScreen session={session} view={view} />
}

interface JoinFormProps {
  onJoin: (name: string) => void
  connecting: boolean
  /** E.g. "The room is full" after being refused. */
  error: string | null
}

function JoinForm({ onJoin, connecting, error }: JoinFormProps) {
  const [name, setName] = useState(() => {
    try {
      return localStorage.getItem(NAME_KEY) ?? ''
    } catch {
      return ''
    }
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    try {
      localStorage.setItem(NAME_KEY, trimmed)
    } catch {
      // remembering the name is only a convenience
    }
    // Synchronously inside the submit handler: join() unlocks audio.
    onJoin(trimmed)
  }

  return (
    <main className="page">
      <h1>Join the room</h1>
      <form className="card row" onSubmit={submit}>
        <input
          aria-label="Your name"
          placeholder="Your name"
          maxLength={32}
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <button className="primary" type="submit" disabled={connecting || !name.trim()}>
          {connecting ? 'Joining…' : 'Join'}
        </button>
      </form>
      {error && <p className="error">{error}</p>}
    </main>
  )
}

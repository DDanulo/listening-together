import { type FormEvent, useState } from 'react'
import { createRoom } from '../session/api'
import { navigate } from './navigation'

export function HomePage() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')

  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const { roomId } = await createRoom()
      navigate(`/r/${roomId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a room')
      setBusy(false)
    }
  }

  const joinByCode = (event: FormEvent) => {
    event.preventDefault()
    if (code.trim()) navigate(`/r/${code.trim().toLowerCase()}`)
  }

  return (
    <main className="page">
      <h1>Listening Together</h1>
      <p className="muted">Play music in sync with friends, wherever they are.</p>
      <section className="card">
        <button className="primary" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : 'Create a room'}
        </button>
        {error && <p className="error">{error}</p>}
      </section>
      <section className="card">
        <form className="row" onSubmit={joinByCode}>
          <input
            aria-label="Room code"
            placeholder="Room code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit">Join</button>
        </form>
      </section>
    </main>
  )
}

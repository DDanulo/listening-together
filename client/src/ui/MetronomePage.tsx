import { useEffect, useMemo, useState } from 'react'
import { createRoom } from '../session/api'
import { MetronomeSession } from '../session/metronome'
import { formatMs } from './format'
import { useTicker } from './useRoom'

export function MetronomePage() {
  useTicker(200)
  const metronome = useMemo(() => new MetronomeSession(), [])
  const [roomId, setRoomId] = useState(() => new URLSearchParams(location.search).get('room') ?? '')
  const [running, setRunning] = useState(false)
  useEffect(() => () => metronome.stop(), [metronome])

  const view = metronome.snapshot()

  const create = async () => {
    const { roomId } = await createRoom()
    setRoomId(roomId)
    history.replaceState(null, '', `?room=${roomId}`)
  }

  const toggle = () => {
    if (running) {
      metronome.stop()
    } else {
      metronome.start(roomId)
    }
    setRunning(!running)
  }

  const rows: [string, string][] = [
    ['Connection', view.connection],
    ['Synced', view.synced ? 'yes' : 'no'],
    ['Clock offset', formatMs(view.offsetMs, 2)],
    ['Best RTT', formatMs(view.bestRttMs, 2)],
    ['Samples', String(view.samples)],
    ['Clock check (A1)', formatMs(view.clockCheckMs, 2)],
    ['Timestamp source', view.timestampSource],
    ['Output latency', formatMs(view.outputLatencyMs, 1)],
  ]

  return (
    <main className="page">
      <h1>Metronome</h1>
      <p className="muted">
        Every device clicks at each whole second of server time (high click every 10 s). Open this page on
        several devices with the same room to hear whether they click together. Two tabs on one machine must show
        the same clock check value.
      </p>
      <section className="card row">
        <input aria-label="Room code" placeholder="Room code" value={roomId} disabled={running}
          onChange={(e) => setRoomId(e.target.value.trim())} />
        <button onClick={create} disabled={running}>New room</button>
        <button className="primary" onClick={toggle} disabled={!roomId}>{running ? 'Stop' : 'Start'}</button>
      </section>
      <dl className="card stats">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </main>
  )
}

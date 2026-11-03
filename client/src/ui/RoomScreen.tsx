import { type ChangeEvent, useEffect, useRef, useState } from 'react'
import type { Member, PlaybackState, Track } from '../protocol/types'
import type { RoomSession, RoomView } from '../session/types'
import { formatMs, formatTime } from './format'
import { useTicker } from './useRoom'

interface Props {
  session: RoomSession
  view: RoomView
}

export function RoomScreen({ session, view }: Props) {
  return (
    <main className="page">
      <Header roomId={view.roomId} />
      {view.error && view.error.code !== 'ROOM_NOT_FOUND' && (
        <p className="error banner">
          {view.error.message}
          <button className="link" onClick={() => session.dismissError()}>Dismiss</button>
        </p>
      )}
      {view.connection === 'closed' && (
        <p className="error banner">
          Disconnected. <a href={location.pathname}>Rejoin</a>
        </p>
      )}
      <Player session={session} view={view} />
      <Queue session={session} view={view} />
      <Members view={view} />
      <SyncPanel session={session} view={view} />
    </main>
  )
}

function Header({ roomId }: { roomId: string }) {
  const [copied, setCopied] = useState(false)
  const link = `${location.origin}/r/${roomId}`
  const copy = () => {
    navigator.clipboard?.writeText(link).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }, () => {})
  }
  return (
    <header className="row spread">
      <h1>Room <code>{roomId}</code></h1>
      <button onClick={copy} title={link}>{copied ? 'Copied!' : 'Copy link'}</button>
    </header>
  )
}

function Player({ session, view }: Props) {
  useTicker(100)
  const [volume, setVolume] = useState(1)
  const playback = view.playback
  const track = view.queue.find((t) => t.trackId === playback?.trackId)
  const position = session.getPositionMs()
  const serverNow = session.getServerTime()
  const pendingMs = playback && serverNow !== null ? playback.effectiveAt - serverNow : 0
  const disabled = !view.sync.synced
  const playing = playback?.status === 'playing'

  const changeVolume = (event: ChangeEvent<HTMLInputElement>) => {
    const value = Number(event.target.value)
    setVolume(value)
    session.setVolume(value)
  }

  return (
    <section className="card">
      <div className="row spread">
        <strong className="title">{track?.title ?? 'Nothing playing'}</strong>
        {pendingMs > 0 && <span className="muted">scheduled… {(pendingMs / 1000).toFixed(1)} s</span>}
      </div>
      <SeekBar session={session} playback={playback} track={track} position={position} serverNow={serverNow}
        disabled={disabled} />
      <div className="row">
        <button
          className="primary"
          disabled={disabled || (!playing && view.queue.length === 0)}
          onClick={() => session.command({ action: playing ? 'pause' : 'play' })}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button disabled={disabled || !playback || playback.status === 'stopped'}
          onClick={() => session.command({ action: 'skip' })}>
          Skip
        </button>
        <label className="row volume">
          Volume
          <input type="range" min={0} max={1} step={0.05} value={volume} onChange={changeVolume} />
        </label>
      </div>
      {disabled && <p className="muted">Synchronizing clock…</p>}
    </section>
  )
}

/** How long a requested seek stays on screen if the server never confirms it (e.g. it was rejected). */
const SEEK_HOLD_TIMEOUT_MS = 3_000

interface SeekBarProps {
  session: RoomSession
  playback: PlaybackState | null
  track: Track | undefined
  position: number | null
  serverNow: number | null
  disabled: boolean
}

function SeekBar({ session, playback, track, position, serverNow, disabled }: SeekBarProps) {
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState<number | null>(null)
  const [held, setHeld] = useState<{ position: number; rev: number } | null>(null)
  const rev = playback?.rev ?? -1
  const durationMs = track?.durationMs ?? 0

  // Commit on the native change event: browsers fire it once on release, after the last input event, for mouse,
  // touch and keyboard alike. (React's onChange is the input event and only drives the preview while dragging.)
  useEffect(() => {
    const element = input.current
    if (!element) return
    const commit = () => {
      const target = Math.min(element.valueAsNumber, durationMs - 1)
      const hold = { position: target, rev }
      setDragging(null)
      setHeld(hold)
      window.setTimeout(() => setHeld((current) => (current === hold ? null : current)), SEEK_HOLD_TIMEOUT_MS)
      session.command({ action: 'seek', position: target })
    }
    element.addEventListener('change', commit)
    return () => element.removeEventListener('change', commit)
  }, [session, rev, durationMs])

  // The audio keeps playing the old position until the seek takes effect (lead time), so until then show
  // where playback is going instead of snapping back.
  const holding = held !== null &&
    (rev <= held.rev || (serverNow !== null && playback !== null && serverNow < playback.effectiveAt))
  const shown = dragging ?? (holding ? held.position : position)

  return (
    <>
      <input
        ref={input}
        type="range"
        className="seek"
        aria-label="Position"
        min={0}
        max={durationMs}
        step={100}
        value={shown ?? 0}
        disabled={disabled || !track}
        onChange={(e) => setDragging(Number(e.target.value))}
      />
      <div className="row spread muted">
        <span>{formatTime(shown)}</span>
        <span>{formatTime(track?.durationMs)}</span>
      </div>
    </>
  )
}

function Queue({ session, view }: Props) {
  const [uploading, setUploading] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const names = memberNames(view.members)

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? [])
    event.target.value = ''
    setError(null)
    for (const file of files) {
      setUploading((n) => n + 1)
      try {
        await session.uploadTrack(file)
      } catch (e) {
        setError(`${file.name}: ${e instanceof Error ? e.message : 'upload failed'}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  return (
    <section className="card">
      <div className="row spread">
        <h2>Queue</h2>
        <label className="button">
          {uploading > 0 ? `Uploading ${uploading}…` : 'Add songs'}
          <input type="file" accept="audio/*,.mp3,.flac,.ogg,.oga,.opus,.wav,.m4a,.webm" multiple hidden
            onChange={upload} />
        </label>
      </div>
      {error && <p className="error">{error}</p>}
      {view.queue.length === 0 && <p className="muted">No songs yet. Add some to start.</p>}
      <ol className="list">
        {view.queue.map((track) => (
          <TrackRow key={track.trackId} track={track} view={view} uploader={names.get(track.uploadedBy)}
            onSelect={() => session.command({ action: 'select', trackId: track.trackId })}
            onRemove={() => session.command({ action: 'remove', trackId: track.trackId })} />
        ))}
      </ol>
    </section>
  )
}

interface TrackRowProps {
  track: Track
  view: RoomView
  uploader: string | undefined
  onSelect: () => void
  onRemove: () => void
}

function TrackRow({ track, view, uploader, onSelect, onRemove }: TrackRowProps) {
  const current = view.playback?.trackId === track.trackId && view.playback.status !== 'stopped'
  const download = view.downloads[track.trackId]
  return (
    <li className={current ? 'current' : undefined}>
      <button className="link grow" onClick={onSelect} disabled={!view.sync.synced}>
        {current ? '▶ ' : ''}{track.title}
      </button>
      <span className="muted">
        {formatTime(track.durationMs)} · {uploader ?? 'someone'}{download && download !== 'ready' ? ` · ${download}` : ''}
      </span>
      <button className="link" aria-label={`Remove ${track.title}`} onClick={onRemove}>✕</button>
    </li>
  )
}

function Members({ view }: { view: RoomView }) {
  const currentTrack = view.playback?.trackId
  return (
    <section className="card">
      <h2>Listeners ({view.members.length})</h2>
      <ul className="list">
        {view.members.map((member) => (
          <li key={member.memberId}>
            <span className="grow">{member.name}{member.memberId === view.me ? ' (you)' : ''}</span>
            <span className="muted">
              {currentTrack && member.downloads[currentTrack] ? `${member.downloads[currentTrack]} · ` : ''}
              {member.sync ? `RTT ${formatMs(member.sync.rttMs, 0)}` : 'syncing'}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function SyncPanel({ session, view }: Props) {
  useTicker(250)
  const serverNow = session.getServerTime()
  const playback = view.playback
  const untilEffective = playback && serverNow !== null ? playback.effectiveAt - serverNow : null
  const clockCheck = view.sync.offsetMs === null ? null : view.sync.offsetMs - performance.timeOrigin
  const rows: [string, string][] = [
    ['Synced', view.sync.synced ? 'yes' : 'no'],
    ['Clock offset', formatMs(view.sync.offsetMs, 2)],
    ['Best RTT', formatMs(view.sync.bestRttMs, 2)],
    ['Samples', String(view.sync.samples)],
    ['Clock check (A1)', formatMs(clockCheck, 2)],
    ['Timing error', formatMs(view.sync.driftMs, 1)],
    ['Resyncs', String(view.sync.resyncs)],
    ['Last resync', view.sync.lastResync
      ? `${formatMs(view.sync.lastResync.errorMs, 0)} (${view.sync.lastResync.timestampSource})` : '–'],
    ['Playback rev', playback ? String(playback.rev) : '–'],
    ['Next change in', untilEffective !== null && untilEffective > 0 ? formatMs(untilEffective, 0) : '–'],
    ['Timestamp source', view.audio.timestampSource],
    ['Output latency', formatMs(view.audio.outputLatencyMs, 1)],
  ]
  return (
    <details className="card" open>
      <summary>Sync status</summary>
      <dl className="stats">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}

function memberNames(members: Member[]): Map<string, string> {
  return new Map(members.map((m) => [m.memberId, m.name]))
}

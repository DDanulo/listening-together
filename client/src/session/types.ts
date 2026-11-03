import type { Command, DownloadStatus, Member, PlaybackState, Track } from '../protocol/types'
import type { TimestampSource } from '../audio/engine'

export interface RoomView {
  connection: 'idle' | 'connecting' | 'open' | 'closed'
  roomId: string
  /** memberId after welcome */
  me: string | null
  members: Member[]
  queue: Track[]
  playback: PlaybackState | null
  /** This client's own downloads. */
  downloads: Record<string, DownloadStatus>
  sync: {
    synced: boolean
    offsetMs: number | null
    bestRttMs: number | null
    samples: number
    /** Timing error of the playing audio (ms, positive = behind); null when not playing. */
    driftMs: number | null
    /** How often playback was restarted to fix a timing error. */
    resyncs: number
    /** Error that triggered the last resync, and the audio clock source used to measure it. */
    lastResync: { errorMs: number; timestampSource: TimestampSource } | null
  }
  audio: { timestampSource: TimestampSource; outputLatencyMs: number | null }
  error: { code: string; message: string } | null
}

/** The only interface the UI uses (docs/poc/02-sync-engine.md). */
export interface RoomSession {
  /** Immutable; a new object on every change (for useSyncExternalStore). */
  getSnapshot(): RoomView
  subscribe(listener: () => void): () => void
  /** MUST be called from a click handler: it unlocks audio. */
  join(name: string): Promise<void>
  command(command: Command): void
  uploadTrack(file: File): Promise<void>
  /** 0..1, local only. */
  setVolume(volume: number): void
  /** Live track position for animation frames (not part of the snapshot). */
  getPositionMs(): number | null
  /** Current server time estimate, e.g. for countdowns to effectiveAt. */
  getServerTime(): number | null
  dismissError(): void
  leave(): void
}

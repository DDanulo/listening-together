// Wire types for protocol v1. Must match docs/protocol.md — change the spec first.
// Times: ms. Fields ending in `At`, and t1/t2, are server time; t0 is client performance.now().

export const PROTOCOL_VERSION = 1

// ---------- shared objects ----------

export type PlaybackStatus = 'playing' | 'paused' | 'stopped'

export interface PlaybackState {
  rev: number
  status: PlaybackStatus
  trackId: string | null
  /** Track position (ms) at server time `effectiveAt`. */
  position: number
  effectiveAt: number
}

export type DownloadStatus = 'downloading' | 'ready' | 'error'

export interface MemberSync {
  offsetMs: number
  rttMs: number
  driftMs: number | null
}

export interface Member {
  memberId: string
  name: string
  connected: boolean
  downloads: Record<string, DownloadStatus>
  sync: MemberSync | null
}

export interface Track {
  trackId: string
  title: string
  durationMs: number
  sizeBytes: number
  mimeType: string
  uploadedBy: string
  url: string
}

export interface RoomSnapshot {
  roomId: string
  members: Member[]
  queue: Track[]
  playback: PlaybackState
}

// ---------- client → server ----------

export interface HelloMessage {
  type: 'hello'
  protocolVersion: number
  clientId: string
  name: string
}

export interface PingMessage {
  type: 'ping'
  seq: number
  t0: number
}

export type Command =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'seek'; position: number }
  | { action: 'skip' }
  | { action: 'select'; trackId: string }
  | { action: 'remove'; trackId: string }

export type CommandMessage = { type: 'command' } & Command

export type CommandAction = Command['action']

export interface TrackStatusMessage {
  type: 'trackStatus'
  trackId: string
  status: DownloadStatus
}

export interface StatsMessage {
  type: 'stats'
  offsetMs: number
  rttMs: number
  driftMs: number | null
  outputLatencyMs: number | null
}

export type ClientMessage =
  | HelloMessage
  | PingMessage
  | CommandMessage
  | TrackStatusMessage
  | StatsMessage

// ---------- server → client ----------

export interface WelcomeMessage {
  type: 'welcome'
  protocolVersion: number
  memberId: string
  /** Informational only — use ping/pong for the clock offset. */
  serverTime: number
  room: RoomSnapshot
}

export interface PongMessage {
  type: 'pong'
  seq: number
  t0: number
  t1: number
  t2: number
}

export interface MembersMessage {
  type: 'members'
  members: Member[]
}

export interface QueueMessage {
  type: 'queue'
  tracks: Track[]
}

export interface PlaybackMessage {
  type: 'playback'
  state: PlaybackState
  /** null for server-initiated changes (auto-advance). */
  cause: { action: CommandAction; memberId: string } | null
}

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'TRACK_NOT_FOUND'
  | 'BAD_MESSAGE'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_COMMAND'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED'
  | 'ROOM_FULL'
  | 'QUEUE_FULL'
  | 'STORAGE_FULL'
  | 'SERVER_BUSY'

export interface ErrorMessage {
  type: 'error'
  code: ErrorCode
  message: string
  ref?: string
}

export type ServerMessage =
  | WelcomeMessage
  | PongMessage
  | MembersMessage
  | QueueMessage
  | PlaybackMessage
  | ErrorMessage

// ---------- WebSocket close codes ----------

export const CloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  PROTOCOL_ERROR: 4400,
  ROOM_NOT_FOUND: 4404,
  ROOM_FULL: 4409,
  RATE_LIMITED: 4429,
} as const

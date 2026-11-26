import { type ClientMessage, type ServerMessage, CloseCode } from '../protocol/types'
import { backoffDelayMs, shouldReconnect } from './reconnect'

export interface ConnectionEvents {
  /** A socket opened (the first one, or after a reconnect): send hello. */
  open(): void
  /** @param receivedAt performance.now() when the frame arrived, taken before parsing (t3 for pongs) */
  message(message: ServerMessage, receivedAt: number): void
  /**
   * The socket closed.
   * @param retryInMs when the next attempt starts, or null if the connection gave up for good
   */
  close(code: number, reason: string, retryInMs: number | null): void
}

export function roomSocketUrl(roomId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/ws/rooms/${encodeURIComponent(roomId)}`
}

/**
 * A WebSocket carrying JSON protocol messages that reconnects with backoff when it drops (protocol §3.2).
 * Messages sent while disconnected are dropped: the session resends what matters after the next welcome.
 */
export class Connection {
  private readonly url: string
  private readonly events: ConnectionEvents
  private socket: WebSocket | null = null
  private attempt = 0
  private retryTimer: number | undefined
  private stopped = false

  constructor(url: string, events: ConnectionEvents) {
    this.url = url
    this.events = events
    window.addEventListener('online', this.retryNow)
    document.addEventListener('visibilitychange', this.retryWhenVisible)
    this.connect()
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }

  /** Abandons a connection that looks dead although the browser hasn't closed it, and reconnects. */
  reconnect(reason: string): void {
    const socket = this.socket
    if (!socket || this.stopped) return
    this.detach(socket)
    socket.close(CloseCode.CLIENT_TIMEOUT, reason)
    this.closed(CloseCode.CLIENT_TIMEOUT, reason)
  }

  /** The user left: close for good. */
  close(): void {
    this.stopped = true
    window.clearTimeout(this.retryTimer)
    window.removeEventListener('online', this.retryNow)
    document.removeEventListener('visibilitychange', this.retryWhenVisible)
    if (this.socket) {
      this.detach(this.socket)
      this.socket.close(CloseCode.NORMAL)
    }
  }

  private connect(): void {
    this.retryTimer = undefined
    const socket = new WebSocket(this.url)
    this.socket = socket
    socket.onopen = () => {
      this.attempt = 0
      this.events.open()
    }
    socket.onmessage = (event: MessageEvent<string>) => {
      // t3 must be taken before anything else, including parsing (protocol §4).
      const receivedAt = performance.now()
      let message: ServerMessage
      try {
        message = JSON.parse(event.data) as ServerMessage
      } catch {
        console.warn('Ignoring malformed message', event.data)
        return
      }
      this.events.message(message, receivedAt)
    }
    socket.onclose = (event) => {
      this.socket = null
      this.closed(event.code, event.reason)
    }
  }

  private closed(code: number, reason: string): void {
    this.socket = null
    if (this.stopped || !shouldReconnect(code)) {
      this.events.close(code, reason, null)
      return
    }
    // Replaced by a duplicate of ourselves: the session picks a new clientId, so rejoin right away.
    const delay = code === CloseCode.REPLACED ? 0 : backoffDelayMs(this.attempt++)
    this.events.close(code, reason, delay)
    this.retryTimer = window.setTimeout(() => this.connect(), delay)
  }

  /** The network is probably back (or the tab woke up): don't wait out the backoff. */
  private readonly retryNow = (): void => {
    if (this.retryTimer === undefined || this.stopped) return
    window.clearTimeout(this.retryTimer)
    this.connect()
  }

  private readonly retryWhenVisible = (): void => {
    if (document.visibilityState === 'visible') this.retryNow()
  }

  /** Events of an abandoned socket must not reach the session (e.g. a late close or a 4410 meant for it). */
  private detach(socket: WebSocket): void {
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    if (this.socket === socket) this.socket = null
  }
}

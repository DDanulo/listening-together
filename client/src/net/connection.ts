import type { ClientMessage, ServerMessage } from '../protocol/types'

export interface ConnectionEvents {
  open(): void
  /** @param receivedAt performance.now() when the frame arrived, taken before parsing (t3 for pongs) */
  message(message: ServerMessage, receivedAt: number): void
  close(code: number, reason: string): void
}

export function roomSocketUrl(roomId: string): string {
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${window.location.host}/ws/rooms/${encodeURIComponent(roomId)}`
}

/** One WebSocket carrying JSON protocol messages. Reconnection is not part of the PoC. */
export class Connection {
  private readonly socket: WebSocket

  constructor(url: string, events: ConnectionEvents) {
    this.socket = new WebSocket(url)
    this.socket.onopen = () => events.open()
    this.socket.onmessage = (event: MessageEvent<string>) => {
      // t3 must be taken before anything else, including parsing (protocol §4).
      const receivedAt = performance.now()
      let message: ServerMessage
      try {
        message = JSON.parse(event.data) as ServerMessage
      } catch {
        console.warn('Ignoring malformed message', event.data)
        return
      }
      events.message(message, receivedAt)
    }
    this.socket.onclose = (event) => events.close(event.code, event.reason)
  }

  send(message: ClientMessage): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }

  close(): void {
    this.socket.close(1000)
  }
}

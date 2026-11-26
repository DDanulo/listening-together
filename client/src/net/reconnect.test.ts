import { describe, expect, it } from 'vitest'
import { CloseCode } from '../protocol/types'
import { LIVENESS_TIMEOUT_MS, backoffDelayMs, looksDead, shouldReconnect } from './reconnect'

describe('backoffDelayMs', () => {
  it('doubles from 0.5 s and then stays at 8 s', () => {
    expect([0, 1, 2, 3, 4, 5, 50].map(backoffDelayMs)).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000])
  })
})

describe('shouldReconnect', () => {
  it('reconnects after network-level closes, timeouts and being replaced', () => {
    for (const code of [1001, 1006, 1011, CloseCode.CLIENT_TIMEOUT, CloseCode.REPLACED]) {
      expect(shouldReconnect(code)).toBe(true)
    }
  })

  it('gives up when the user left or the server refused us', () => {
    for (const code of [CloseCode.NORMAL, CloseCode.PROTOCOL_ERROR, CloseCode.ROOM_NOT_FOUND, CloseCode.ROOM_FULL,
      CloseCode.RATE_LIMITED]) {
      expect(shouldReconnect(code)).toBe(false)
    }
  })
})

describe('looksDead', () => {
  it('is alive while no ping is outstanding, however long ago the last pong was', () => {
    expect(looksDead(null, 1_000_000)).toBe(false)
  })

  it('is dead once a ping stays unanswered past the timeout', () => {
    expect(looksDead(10_000, 10_000 + LIVENESS_TIMEOUT_MS)).toBe(false)
    expect(looksDead(10_000, 10_001 + LIVENESS_TIMEOUT_MS)).toBe(true)
  })
})

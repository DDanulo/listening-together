# 02 — Sync engine (client)

**Folders:** `client/src/sync`, `net`, `audio`, plus `session` · **Rules:** "Timing rules" in [CLAUDE.md](../../CLAUDE.md)

## Module overview

```
sync/clock.ts        computeSample (done), ClockEstimator — pure
sync/playback.ts     expectedPosition, planPlayback(state, now) — pure
net/connection.ts    WebSocket: hello, dispatch, ping scheduler
audio/engine.ts      AudioContext, decode cache, time mapping, start/stop, volume
session/session.ts   RoomSession: wires net + sync + audio, exposes state to the UI
ui/debug/Metronome   debug page (week 2 milestone, permanent measurement tool)
```

## Tasks

### Week 2: clock sync and metronome

**E1. `ClockEstimator` (`sync/clock.ts`)**
- `addSample(sample, clientTime)`; `offset()`; `bestRtt()`; `sampleCount()`; `isSynced()` (≥ 5 samples).
- Keep samples from the **last 30 s** only. Client and server clocks drift apart by roughly 0.01–0.1 ms per second, so old samples go stale. Regression-based drift handling comes in week 5.
- Offset = **median of the 3 lowest-RTT samples** in the window. This resists jitter spikes and single outliers.

**E2. Connection (`net/connection.ts`)**
- Open `/ws/rooms/{roomId}` (`wss:` when the page is `https:`), send `hello`, dispatch typed `ServerMessage`s.
- Ping scheduler: burst of 10 pings 50 ms apart after `welcome`, then 3 pings every 5 s.
- `t3 = performance.now()` as the **first statement** in `onmessage`, before `JSON.parse`.
- `clientId`: `crypto.randomUUID()` stored in `sessionStorage` (the server ignores it in the PoC, but send it per spec).

**E3. Metronome debug page (`/debug/metronome?room=…`)**
- Each client plays a short beep at every **whole second of server time** (`serverTime % 1000 == 0`), scheduled through Web Audio.
- It tests clock sync + scheduling **in isolation**, without uploads or the playback model. It's the **M1 milestone** and stays useful for experiments (E2 in the evaluation plan).
- Shows: offset, best RTT, sample count, and the **clock check value** `offset - performance.timeOrigin`. Two tabs on the same machine must show the same value (see A1 in [05-acceptance.md](05-acceptance.md)).

### Week 3: audio engine and session

**E4. Time mapping (`audio/engine.ts`)**
- Server → client: `clientTime = serverTime - offset`.
- Client → AudioContext: use `ctx.getOutputTimestamp()`, which returns a pair `{contextTime, performanceTime}`:
  `audioTime(clientTime) = contextTime + (clientTime - performanceTime) / 1000` (**AudioContext time is in seconds!**).
- `getOutputTimestamp` refers to the moment a sample **comes out of the speaker**, so it already includes part of the output latency. Fallback where it's missing: sample `ctx.currentTime` together with `performance.now()`. Record which one each browser used (needed for the acceptance results).
- Keep all conversions in this one place.

**E5. Playback planning (`sync/playback.ts`, pure)**
- `expectedPosition(state, serverTime) = state.position + (serverTime - state.effectiveAt)` for `playing`.
- `planPlayback(state, lastAppliedRev, serverNow)` returns one of:
  - `ignore` (stale `rev`)
  - `startAt {serverTime, position}`: `effectiveAt` is still ≥ 30 ms in the future
  - `startLate {serverTime: now + 30, position: expectedPosition(now + 30)}`: `effectiveAt` has passed (late message / late join)
  - `stopAt {serverTime}`: paused/stopped
- The 30 ms safety margin gives Web Audio time to schedule. Make it a named constant.

**E6. Audio engine**
- Decode: `fetch(track.url)` → `arrayBuffer` → `decodeAudioData`, cached by `trackId`. Report `trackStatus` (`downloading` → `ready`/`error`).
- Memory: a decoded 4-minute stereo track is ~80 MB. Keep only the **current + next** track decoded. Downloads ahead of time only fill the browser's **HTTP cache** (track files are `immutable`); nothing else is kept in memory, since a room can hold 30 × 50 MB. Decoding fetches the file again, normally from the cache.
- Start: new `AudioBufferSourceNode` → `GainNode` (volume) → destination; `start(audioTime, positionSeconds)`.
- Stop: `stop(audioTime)` on the current node. Seek/skip = stop the current node at `effectiveAt` and start a new one at `effectiveAt`.
- If the track isn't decoded yet when it should play: start it with `startLate` as soon as it's ready.
- `AudioContext` is created/resumed in the **Join click handler** (autoplay policy; iOS needs this).

**E7. `RoomSession`**: see the interface below. It owns the connection, estimator and engine, and applies `playback` messages via `planPlayback`.

### Week 4: complete and harden

**E8. Late join:** after `welcome`, wait for `isSynced()`, then apply the snapshot's `playback` (→ `startLate`).
**E9. `stats`:** send every 2 s: `offsetMs`, `rttMs` (best), `driftMs` (timing error from E12, `null` when not playing), `outputLatencyMs` (`ctx.outputLatency` if available, else `null`).

**E12. Timing check + hard resync** (added after a bug: after a long pause the audio output went idle, so the first start was scheduled with a stale audio clock and stayed 1–2 s off):
- `getOutputTimestamp()` readings older than 250 ms are treated as stale (fallback: `currentTime`).
- The `currentTime` fallback is shifted by `baseLatency + outputLatency`, so both clock sources describe the moment sound leaves the speaker. Mixing unshifted sources showed up as fake drift (repeated resyncs).
- Every 1 s, measure when the playing audio actually comes out vs. when it should, with a fresh reading. **Two consecutive** errors > 20 ms in the same direction → restart it at the correct position (at most every 3 s). Logic in `sync/drift.ts`.
- This is the hard-resync variant of FR10; playback-rate nudging is compared against it in week 5 (evaluation E3).
**E10. Edge cases:** command while the track is still downloading; two commands within the lead time (the higher `rev` wins and replaces the scheduled node); a track removed while decoding; the tab hidden in the background (verify that scheduled audio still plays).
**E11 (optional, useful for the report). Naive mode:** `?naive=1` ignores `effectiveAt` and starts/stops immediately when a message arrives. This is the "before" baseline that the scheduled version is compared against.

## `RoomSession` interface

This is the boundary between the sync engine and the UI. The UI only uses this interface.

The implemented interface is `client/src/session/types.ts`:

```ts
export interface RoomView {
  connection: 'idle' | 'connecting' | 'open' | 'closed'
  roomId: string
  me: string | null                       // memberId after welcome
  members: Member[]
  queue: Track[]
  playback: PlaybackState | null
  downloads: Record<string, DownloadStatus> // this client's own downloads
  sync: { synced: boolean; offsetMs: number | null; bestRttMs: number | null; samples: number;
          driftMs: number | null; resyncs: number }
  audio: { timestampSource: 'outputTimestamp' | 'currentTime'; outputLatencyMs: number | null }
  error: { code: string; message: string } | null
}

export interface RoomSession {
  getSnapshot(): RoomView                 // immutable; a new object on every change
  subscribe(listener: () => void): () => void   // for useSyncExternalStore
  join(name: string): Promise<void>       // MUST be called from a click handler (unlocks audio)
  command(command: Command): void
  uploadTrack(file: File): Promise<void>  // reads duration, POSTs multipart
  setVolume(volume: number): void         // 0..1, local only
  getPositionMs(): number | null          // live position for animation frames (not in the snapshot)
  getServerTime(): number | null          // for countdowns to effectiveAt
  dismissError(): void
  leave(): void
}
```

## Tests (vitest)

| # | Test |
|---|---|
| U1 | `computeSample`: symmetric and asymmetric delay (done) |
| U2 | `ClockEstimator` picks the low-RTT samples: 10 samples with RTT 20–25 ms plus 2 spikes of 300 ms → offset unaffected by the spikes |
| U3 | `ClockEstimator` drops samples older than 30 s |
| U4 | `isSynced()` false below 5 samples |
| U5 | `expectedPosition` for playing (before/after `effectiveAt`) and for paused (constant) |
| U6 | `planPlayback`: future → `startAt`; past → `startLate` with the correct position; stale `rev` → `ignore`; paused → `stopAt` |
| U7 | `planPlayback` with `effectiveAt` 10 ms ahead (< margin) → `startLate`, not `startAt` |
| U8 | Time mapping: server → client → audio time with fixed numbers (seconds vs ms!) |

The time mapping must be a **pure function** taking `{contextTime, performanceTime}` as input, so it can be tested without an `AudioContext`.

## Done when
- [ ] U1–U8 pass
- [ ] **M1:** metronome: two tabs show the same clock check value (A1); two devices beep audibly together
- [ ] **M2:** two devices start an uploaded track together (measured in A3)
- [ ] `RoomSession` implemented; the UI runs on it
- [ ] No `Date.now()`, no `setTimeout`-started audio (`grep -rn "Date.now\|setTimeout" client/src/sync client/src/audio` — every hit justified)

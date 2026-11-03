# 01 — Server (Spring Boot)

**Spec:** [../protocol.md](../protocol.md) · **Package root:** `pl.lodz.p.sina.listening`

## Architecture

```
api/        RoomController, TrackController           HTTP (§2)
ws/         RoomSocketHandler, WebSocketConfig        raw WebSocket /ws/rooms/{roomId} (§3)
protocol/   records for every message + Jackson setup  (§6)
room/       RoomRegistry, Room, Member, Track, PlaybackState, PlaybackService
clock/      ServerClock                                monotonic ms since start
log/        EventLog                                   JSON lines for evaluation
```

## Tasks

### Week 2: connection and clock (unblocks the sync engine, do first)

**S1. `ServerClock`**
- `double nowMs()` = `(System.nanoTime() - startNanos) / 1_000_000.0`.
- Single bean, used for **every** protocol time. Never `System.currentTimeMillis()`, except in log lines as a human-readable timestamp.

**S2. Protocol records + JSON**
- One record per message type in `protocol/`. Deserialize client messages polymorphically by `"type"` (Jackson `@JsonTypeInfo(property = "type")` + `@JsonSubTypes`).
- Spring Boot 4 uses **Jackson 3** (`tools.jackson.*` packages). Old Jackson 2 examples from the internet need adjusting.
- `command` can be one flat record (`action`, optional `position`, optional `trackId`) with validation per action. That's simpler than subtypes.
- Unknown fields ignored; unknown `type` → `error BAD_MESSAGE`.

**S3. Rooms (HTTP)**
- `POST /api/rooms` → `{roomId}`. IDs: 6 chars from `abcdefghjkmnpqrstuvwxyz23456789` (no look-alike characters), `SecureRandom`.
- `GET /api/rooms/{roomId}` → `{roomId, memberCount}` or `404 ROOM_NOT_FOUND`.
- `RoomRegistry`: `ConcurrentHashMap<String, Room>`.

**S4. WebSocket handler**
- **Raw WebSocket** (`TextWebSocketHandler`), **not STOMP**. The spec is plain JSON frames.
- Endpoint `/ws/rooms/{roomId}`. Extract `roomId` in a `HandshakeInterceptor`, and reject unknown rooms after the handshake with `error` + close `4404`.
- Wrap every session in `ConcurrentWebSocketSessionDecorator`. `WebSocketSession.sendMessage` is **not thread-safe**, and broadcasts come from several threads.
- `hello` must be first; then reply `welcome` with the full snapshot and broadcast `members`.
- Allowed origins: configurable (`app.ws.allowed-origins`), so the dev proxy and the production domain both work.

**S5. `ping` → `pong`**
- Take `t1 = clock.nowMs()` as the **first statement** in `handleTextMessage`, before JSON parsing.
- Take `t2` right before `sendMessage`. Nothing in between except parsing and building the reply.
- Never route pings through a queue shared with slow work.

### Week 3: files and basic playback

**S6. Upload / download**
- `POST /api/rooms/{roomId}/tracks` (multipart: `file`, `durationMs`, `title?`, `memberId`). Limits already in `application.properties` (50 MB).
- Accept `audio/*`. Some OSes send FLAC/OGG as `application/octet-stream`, so also accept by extension (`.mp3 .flac .ogg .oga .wav .m4a .opus`).
- Store files in a temp directory per room (`Files.createTempDirectory`), with metadata in memory. Write the file **outside** the room lock.
- Append to the queue, broadcast `queue`, return `Track` (`201`).
- `GET …/tracks/{trackId}/file`: stream the file with `Content-Type`, `Content-Length`, `Cache-Control: private, max-age=86400, immutable`.

**S7. Playback state machine (`PlaybackService`)**
- One `PlaybackState` per room; every change: `rev + 1`, `effectiveAt = now + leadMs` (`app.playback.lead-ms`, default `1000`).
- Implement `play` and `pause` first (week 3), the rest in week 4. Rules: [protocol §5–6](../protocol.md#5-playback-model).
- Helper `expectedPosition(state, serverTime)`, used for `pause` and `seek` validation.
- All mutations of a room under that room's lock. Broadcast `playback` (with `cause`) to all members, sender included.

### Week 4: complete the feature set

**S8. Remaining commands:** `seek` (reject beyond `durationMs` → `INVALID_COMMAND`), `skip`, `select`, `remove` (removing the current track = skip first).

**S9. Auto-advance**
- On every state change, cancel the pending timer and schedule one (`ScheduledExecutorService`) at `endAt - leadMs`, where `endAt = effectiveAt + (durationMs - position)`.
- When it fires: next track at `position 0`, `effectiveAt = endAt` (no gap), or `stopped` if the queue is finished. `cause: null`.

**S10. `trackStatus` and `stats`**
- `trackStatus` → update `Member.downloads`, broadcast `members`.
- `stats` → store in `Member.sync`, write to the event log, broadcast `members` **at most every 2 s** per room.

**S11. Event log (JSON lines)**
- `logs/events-<date>.jsonl`, one line per `stats` message and per playback change:
  `{"wallTime":"…","serverTime":905120.0,"roomId":"…","memberId":"…","event":"stats",…payload}`
- Write asynchronously (don't block the WebSocket thread). The evaluation scripts parse this in week 6.

## PoC simplifications (allowed deviations from the spec)

| Spec | PoC |
|---|---|
| Reconnect keeps `memberId` (`clientId`), 60 s grace period | Disconnect removes the member immediately; reconnecting = joining again (late join) |
| Room deleted 10 min after last member leaves | Rooms live until server restart |
| Close code `1001` on shutdown | Not required |

## Tests (JUnit)

| # | Test | Type |
|---|---|---|
| T1 | `ServerClock` is monotonic and in ms | unit |
| T2 | Room ID format (6 chars, allowed alphabet), lookup of unknown room → 404 | unit / MockMvc |
| T3 | `play` from `stopped` starts the first track at `position 0`, `effectiveAt = now + lead` | unit |
| T4 | `pause` at server time X: `position = expectedPosition(effectiveAt)`, status `paused` | unit |
| T5 | `seek` keeps status; `seek` beyond duration → `INVALID_COMMAND` | unit |
| T6 | `skip` on last track → `stopped` | unit |
| T7 | `remove` of the current track behaves like `skip` | unit |
| T8 | `rev` increases by exactly 1 per change | unit |
| T9 | Auto-advance: next state has `effectiveAt == endAt` and `position 0` | unit (inject clock + executor) |
| T10 | WebSocket: message before `hello` → `BAD_MESSAGE`; unknown `type` → `BAD_MESSAGE`; wrong `protocolVersion` → close `4400` | integration |
| T11 | WebSocket: `pong` echoes `seq`/`t0`, and `t1 ≤ t2` | integration |
| T12 | WebSocket: two clients join; a command from A → **both** receive the same `playback` (same `rev`) | integration |
| T13 | Upload: non-audio → 415; > 50 MB → 413; success → `queue` broadcast | MockMvc / integration |
| T14 | Download headers (`Content-Type`, `Content-Length`, `Cache-Control`) | MockMvc |

Make `ServerClock` injectable (interface + fake) so the state-machine tests use fixed times.

## Done when
- [ ] T1–T14 pass (`./mvnw test`)
- [ ] A client following the spec can join, sync, upload, and run every command without errors in the server log
- [ ] `logs/events-*.jsonl` contains `stats` and playback lines with `serverTime`
- [ ] `pong` handling verified with an RTT of < 1 ms on localhost (seen in the client sync panel)

# Listening Together, Apart

Web app that plays music **in sync across remote devices** (e.g. friends in a Discord call). Users create a room, share the link, upload audio files, and every participant hears playback aligned to within a few milliseconds.

University project (Selected Issues of Network Applications, TUL, 2026/27). Besides the app, the deliverable is an **evaluation** of sync accuracy under different network conditions, so measurability matters as much as features.

## Repository layout

```
docs/protocol.md   Client–server protocol — SINGLE SOURCE OF TRUTH, read before touching messages
docs/poc/          PoC plan: workstreams, tests, acceptance metrics — check here for current tasks
server/            Java 21, Spring Boot 4, Maven — rooms, playback state, reference clock, files
client/            TypeScript, React, Vite — UI, clock sync, Web Audio playback
eval/              Measurement tooling: netem scenarios, recording analysis, charts
```

Client `src/` layout (create folders as needed, keep the boundaries):

| Folder | Contents | May import |
|---|---|---|
| `protocol/` | Wire types matching `docs/protocol.md` | nothing |
| `sync/` | Clock offset estimation, position/scheduling math, drift logic. **Pure TypeScript** | `protocol/` |
| `net/` | WebSocket connection, reconnect, message dispatch | `protocol/` |
| `audio/` | Web Audio engine: decode, schedule, drift correction | `sync/`, `protocol/` |
| `session/` | `RoomSession`: wires `net` + `sync` + `audio` and exposes state to the UI (interface in `docs/poc/02-sync-engine.md`) | everything except `ui/` |
| `ui/` | React components and hooks | everything |

`sync/` must not import React, `net/` or browser audio APIs. It is unit-tested in isolation and will be reused when a WebRTC transport is added later (offline local mode).

Server packages under `pl.lodz.p.sina.listening`: `protocol` (message records), `ws` (WebSocket handler), `api` (HTTP controllers), `room` (room/queue/playback state), `clock` (server clock).

## Commands

```bash
# server (http://localhost:8080)
cd server && ./mvnw spring-boot:run
cd server && ./mvnw test

# client (http://localhost:5173, proxies /api and /ws to :8080)
cd client && npm install
cd client && npm run dev
cd client && npm test          # vitest
cd client && npm run build     # type-check + production build
cd client && npm run lint      # oxlint
```

The local JDK may be newer than 21; the build targets Java 21 (`java.version` in `pom.xml`), so don't use newer language features.

## Timing rules — the core of the project

These rules are easy to break and break sync silently. Follow them everywhere.

1. **Clocks:** the client uses `performance.now()`; the server uses its monotonic clock (`System.nanoTime()`, ms since start). **Never use `Date.now()` / `System.currentTimeMillis()` for anything sync-related.**
2. **All times are milliseconds** as `number`/`double`. Name variables with their clock when it's ambiguous: `serverTime`, `clientTime`, `audioTime` (AudioContext, seconds!). Convert at the boundary, in one place.
3. **Never start or stop audio with `setTimeout`/`setInterval`.** Schedule with Web Audio (`AudioBufferSourceNode.start(when, offset)` / `stop(when)`). Timers are fine for UI updates and for waking up shortly before an event.
4. **The server is authoritative.** Clients send `command` and apply the change only when the `playback` broadcast arrives. No optimistic local changes.
5. **Ignore stale state:** apply a `PlaybackState` only if its `rev` is greater than the last applied one.
6. **Late is normal.** If `effectiveAt` has already passed, start at `position + (now - effectiveAt)`. Never restart from `position`.
7. **Disconnect ≠ stop.** Audio is local; keep playing on the last known state while reconnecting.
8. On the server, take `t1` first thing on receiving `ping` and `t2` right before sending `pong`. Don't put work between them.

## Protocol changes

`docs/protocol.md` is the contract. To change it:
1. Edit the spec first.
2. Update `client/src/protocol/types.ts` **and** the server records in `protocol/` in the same merge request.
3. Breaking change → bump `protocolVersion`. Additive optional fields → no bump.

Never add a message or field in code that isn't in the spec.

## Conventions

- **TypeScript:** strict mode, no `any`. Prefer plain functions and small modules; React only in `ui/`.
- **Java:** records for messages and immutable state; constructor injection; no Lombok. Room state is mutated only under that room's lock (or one executor per room). Don't block WebSocket handler threads with file I/O.
- **Comments:** explain *why* (especially timing decisions); don't restate code.
- **Abuse limits:** every limit lives in `AppProperties` (`app.*` properties), with defaults documented in `docs/poc/04-deployment.md`. Anything a client can create (rooms, tracks, members, messages) must be bounded; `LimitsIntegrationTest` covers each limit. Uploaded files are untrusted: their type is detected from content (`AudioFormat`), never from the name or claimed `Content-Type`.
- **Logging for evaluation:** the server must log every `stats` message and every playback change as JSON lines. Don't remove or reformat these logs without updating `eval/`.

## Testing

- Every piece of timing math in `client/src/sync/` gets a vitest unit test with explicit numbers (see `clock.test.ts`).
- Server: JUnit tests for room/playback state transitions (pause position, auto-advance, `rev` increments).
- Real sync quality can only be checked on real devices: test with ≥2 devices before calling a sync-related change done, and say what was tested.

## Workflow

- GitHub (`DDanulo/listening-together`). Branch per change: `feat/…`, `fix/…`, `docs/…`, `eval/…`; merge into `main`.
- Small pull requests.
- Commit messages: imperative, short subject (`Add ping burst on reconnect`), body explains why when it isn't obvious.

## Team

Danylo Dobrianslyi, Mateusz Chodulski, Karol Dawid, Remigiusz Bartczak.

## Schedule

7 weeks. **PoC at end of week 4:** two or more devices on different networks play in sync, with pause/seek/skip, queue, late join, a basic UI, and deployment over HTTPS. Weeks 5–7: drift correction, reconnection, measurements, comparison, report.

## Out of scope (for now)

- Local/offline mode (WebRTC over a phone hotspot, QR signaling) — future work; keep `sync/` transport-agnostic so it stays possible.
- Spotify/YouTube playback — impossible due to DRM; only user-uploaded files.
- Accounts/auth — rooms are anonymous and temporary.

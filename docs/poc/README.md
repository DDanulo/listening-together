# Proof of Concept — plan

**Goal (end of week 4):** two or more devices on **different networks** join a room through a public HTTPS link, and play uploaded tracks **in sync**, including pause, seek, skip, queue and late joining.

This folder splits the PoC into workstreams. Each file lists tasks, the tests that prove them, and a "done when" checklist. The final verification is in [05-acceptance.md](05-acceptance.md).

| File | Workstream |
|---|---|
| [01-server.md](01-server.md) | Spring Boot server: rooms, WebSocket, clock, playback state, files |
| [02-sync-engine.md](02-sync-engine.md) | Clock sync, scheduling, Web Audio engine, `RoomSession` |
| [03-client-ui.md](03-client-ui.md) | React UI on top of `RoomSession` |
| [04-deployment.md](04-deployment.md) | Oracle Cloud VM, HTTPS, WebSocket proxy |
| [05-acceptance.md](05-acceptance.md) | Metrics, measurement method, test scenarios, results sheet |

The protocol is defined in [../protocol.md](../protocol.md). Where the PoC deliberately implements less than the spec, it's listed under "PoC simplifications" in the workstream file.

---

## Scope

### In the PoC
| Requirement (proposal) | What the PoC delivers |
|---|---|
| FR1–FR3 | Create room → link, join with name, member list |
| FR4–FR5 | Upload MP3/FLAC/OGG/WAV ≤ 50 MB; all clients download automatically; download status visible |
| FR6 | Play, pause, seek, skip, select, remove: applied in sync on all devices |
| FR7 | Late join starts at the current position |
| FR8 | Local volume slider |
| FR9 | Clock sync: burst on join + periodic pings, best-of-N filtering |
| FR12 | Sync status panel: offset, RTT, sample count, state revision |
| — | Public deployment with HTTPS / WSS |
| — | Server event log (stats + playback changes) as JSON lines, needed for later evaluation |

### Not in the PoC (weeks 5–7)
- FR10 drift correction beyond the hard resync (playback-rate nudging), FR11 reconnection with the same identity, FR13 output-latency calibration
- Clock drift compensation (regression), improved filtering
- Room cleanup timers. Rooms can live until the server restarts.

---

## Timeline and milestones

The two boundaries that keep the parts independent are:
- the **protocol** (server ↔ client), and
- the **`RoomSession` interface** (sync engine ↔ UI), defined in [02-sync-engine.md](02-sync-engine.md#roomsession-interface).

| Week | Server (01) + deployment (04) | Sync engine (02) | UI (03) | Acceptance (05) | Milestone |
|---|---|---|---|---|---|
| **2** | Clock, `hello`/`welcome`, `ping`/`pong`, rooms API. **Deploy early** (VM, domain, Caddy) | Clock estimator, `net/` connection, **metronome debug page** | Routing, home/join screens | Click track, recording procedure dry run | **M1:** clock offset measured between two browsers; metronome beeps in sync |
| **3** | Upload/download, playback state machine (play, pause), broadcasts | Audio engine, real `RoomSession`, start/stop scheduling | Upload flow, queue, player controls on the real session | First audio measurement (2 devices) | **M2:** two devices start a track together |
| **4** | Seek/skip/select/remove, auto-advance, `trackStatus`, `stats`, event log | Late join, `stats` sending, edge cases | Members + sync panel, volume, mobile check | **Full acceptance run** | **M3: PoC accepted** |

### Critical path
```
server clock + ping/pong ─► clock estimator ─► metronome (M1)
                                                   │
rooms API + upload/download ─► audio engine ─► synced start (M2)
                                                   │
playback state machine ─► commands + late join ─► acceptance (M3)
deployment (week 2!) ──────────────────────────────┘   (remote tests need it)
```
Deploy in week 2, not week 4. Every "different networks" test depends on the public server.

---

## Definition of done (PoC)

The PoC is done when **all** of these hold. Details and thresholds are in [05-acceptance.md](05-acceptance.md).

1. All automated tests pass: `./mvnw test`, `npm test`, `npm run build`, `npm run lint`.
2. Functional checklist F1–F20 passes on desktop Chrome and Firefox.
3. Measured sync meets the PoC thresholds:

   | Metric | Threshold |
   |---|---|
   | Clock consistency, two tabs on one machine | ≤ 1 ms (localhost), ≤ 3 ms (deployed) |
   | Audio spread, 2 laptops, same Wi-Fi | median ≤ 20 ms, max ≤ 40 ms |
   | Audio spread, laptop + phone on mobile data (different networks) | median ≤ 50 ms |
   | Audio spread after pause/seek/skip/late join | same thresholds as the scenario |
   | Time from "Join" to "synced" | ≤ 2 s |

4. Results recorded in the results sheet in [05-acceptance.md](05-acceptance.md#results-sheet), including measured audio output latencies. They serve as the **baseline** for the week 5 improvements and the report.

The final target from the proposal (10–20 ms) applies after week 5–6 (drift correction, latency calibration). The PoC only needs to be "roughly in sync", with numbers.

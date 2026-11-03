# 03 — Client UI (React)

**Folder:** `client/src/ui` · **Depends on:** the `RoomSession` interface in [02-sync-engine.md](02-sync-engine.md#roomsession-interface)

The UI holds **no sync logic**. It renders `RoomView` and calls `RoomSession` methods. Use `useSyncExternalStore(session.subscribe, session.getSnapshot)` in a `useRoom()` hook.

## Screens

Routing without a library: parse `location.pathname`. Vite already serves `index.html` for unknown paths in dev; production is handled by the Caddy config ([04-deployment.md](04-deployment.md)).

| Route | Screen | Contents |
|---|---|---|
| `/` | Home | "Create room" → `POST /api/rooms` → navigate to `/r/{roomId}` |
| `/r/{roomId}` | Join | Check `GET /api/rooms/{id}` → "room not found" state, or a name input + **Join** button. Join calls `session.join(name)` **inside the click handler** (unlocks audio) |
| `/r/{roomId}` (joined) | Room | Everything below |
| `/debug/metronome` | Metronome | See [02-sync-engine.md](02-sync-engine.md) (E3) |

### Room screen

| Area | Requirement | FR |
|---|---|---|
| Header | Room link + **Copy link** button | FR1 |
| Members | Names, "you" marker, per-member download state of the current track, per-member offset/RTT (`sync`) | FR3, FR12 |
| Queue | Track list (title, duration, uploader), current track highlighted, click = `select`, remove button | FR4, FR6 |
| Upload | File picker (multiple files), accepted types `audio/*`, progress/spinner, error message for 413/415 | FR4 |
| Player | Play/pause button, **seek bar** (position from `getPositionMs()` via `requestAnimationFrame`, drag = `seek`), skip button, current time / duration | FR6 |
| Volume | Local slider → `setVolume` | FR8 |
| Sync panel | Synced yes/no, offset, best RTT, sample count, playback `rev`, countdown to the next `effectiveAt`, timestamp source, output latency. Collapsible; open by default during the PoC | FR12 |
| Errors | Show `RoomView.error` (e.g. `INVALID_COMMAND`) as a dismissible message | — |

**Interaction rules**
- Buttons send commands and **don't change the displayed state themselves**. The state changes when the broadcast arrives, about 1 s later because of the lead time. Show a small "scheduled…" indicator during that second, so it doesn't feel broken.
- The seek bar shows the local preview while dragging, and sends `seek` only on release.
- Disable controls until `sync.synced` is true.

**Design:** keep it plain and readable, and usable on a phone screen (one column, large touch targets). The UI isn't evaluated; the sync is.

## Tests
- Component tests are **optional** for the PoC. Priority is the manual checklist below on real browsers.
- `npm run build` and `npm run lint` must pass (type errors = failed build).

## Manual browser checklist (week 4)

| Browser | Create | Join | Upload | Controls | Seek bar smooth | Layout OK |
|---|---|---|---|---|---|---|
| Chrome desktop | | | | | | |
| Firefox desktop | | | | | | |
| Chrome Android | | | | | | |
| Safari iOS (best effort) | | | | | | |

## Done when
- [ ] All screens work on the real `RoomSession`
- [ ] Manual checklist passes on Chrome + Firefox desktop; results recorded for mobile
- [ ] Usable at 375 px width (phone) without horizontal scrolling
- [ ] The sync panel shows every value listed above (needed for acceptance tests A1–A2)

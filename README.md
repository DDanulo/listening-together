# Listening Together, Apart

Real-time synchronized music playback across remote devices.

Create a room, share the link with friends, upload songs, and everyone hears the same music at the same moment, kept in sync to within a few milliseconds. Built for the *Selected Issues of Network Applications* course at Lodz University of Technology (2026/2027).

## How it works

1. **Clock synchronization:** each browser estimates the offset between its clock and the server's using an NTP-style ping exchange.
2. **Scheduled playback:** play, pause, seek and skip are scheduled for a moment slightly in the future, and every device starts the audio exactly then with the Web Audio API.
3. **Drift correction:** devices continuously compare their position with the expected one and correct small deviations.

Songs are downloaded in full before playing, so only small control messages travel over the network.

Details: [`docs/protocol.md`](docs/protocol.md).

## Running locally

Requirements: JDK 21+, Node.js 22+.

```bash
# terminal 1 — server on :8080
cd server
./mvnw spring-boot:run

# terminal 2 — client on :5173
cd client
npm install
npm run dev
```

Open http://localhost:5173. To test with other devices on your network, run `npm run dev -- --host` and open the shown network address.

## Repository

| Path | Contents |
|---|---|
| `server/` | Spring Boot server (Java 21) |
| `client/` | React + TypeScript web client |
| `docs/` | Protocol specification |
| `eval/` | Measurement scripts and results |

## Team

Danylo Dobrianslyi · Mateusz Chodulski · Karol Dawid · Remigiusz Bartczak

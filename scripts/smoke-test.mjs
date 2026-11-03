// Protocol smoke test: two clients, clock sync, upload, play, pause.
// Usage: node scripts/smoke-test.mjs [baseUrl]   (default http://localhost:5173; works against a deployment too)
const base = process.argv[2] ?? 'http://localhost:5173'
const wsBase = base.replace(/^http/, 'ws')
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok, detail })

function client(roomId, name) {
  const ws = new WebSocket(`${wsBase}/ws/rooms/${roomId}`)
  const inbox = []
  const waiters = []
  const samples = []
  ws.onmessage = (event) => {
    const t3 = performance.now()
    const msg = JSON.parse(event.data)
    if (msg.type === 'pong') {
      samples.push({ offset: ((msg.t1 - msg.t0) + (msg.t2 - t3)) / 2, rtt: (t3 - msg.t0) - (msg.t2 - msg.t1) })
    }
    inbox.push(msg)
    waiters.splice(0).forEach((w) => w())
  }
  const next = (type, timeout = 5000) => new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error(`${name}: no ${type}`)), timeout)
    const tryTake = () => {
      const i = inbox.findIndex((m) => m.type === type)
      if (i >= 0) {
        clearTimeout(deadline)
        resolve(inbox.splice(i, 1)[0])
      } else waiters.push(tryTake)
    }
    tryTake()
  })
  const send = (msg) => ws.send(JSON.stringify(msg))
  const offset = () => {
    const best = [...samples].sort((a, b) => a.rtt - b.rtt).slice(0, 3).map((s) => s.offset).sort((a, b) => a - b)
    return best[1]
  }
  const opened = new Promise((resolve) => (ws.onopen = resolve))
  return { ws, next, send, samples, offset, opened }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const { roomId } = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json()
check('create room via proxy', typeof roomId === 'string', roomId)

const a = client(roomId, 'alice')
const b = client(roomId, 'bob')
await Promise.all([a.opened, b.opened])
a.send({ type: 'hello', protocolVersion: 1, clientId: 'a', name: 'alice' })
b.send({ type: 'hello', protocolVersion: 1, clientId: 'b', name: 'bob' })
const welcomeA = await a.next('welcome')
await b.next('welcome')
check('welcome over proxied WebSocket', !!welcomeA.memberId, welcomeA.memberId)

for (let i = 0; i < 10; i++) {
  a.send({ type: 'ping', seq: i, t0: performance.now() })
  b.send({ type: 'ping', seq: i, t0: performance.now() })
  await sleep(50)
}
await sleep(200)
const diff = Math.abs(a.offset() - b.offset())
const bestRtt = Math.min(...a.samples.map((s) => s.rtt))
check('A1: two clients on one clock agree on server time (≤ 1 ms)', diff <= 1,
  `diff ${diff.toFixed(3)} ms, best RTT ${bestRtt.toFixed(3)} ms, samples ${a.samples.length}`)

const form = new FormData()
// starts like an MP3 (ID3 tag): the server checks the content, not the name
const fakeMp3 = new Uint8Array(1000)
fakeMp3.set([0x49, 0x44, 0x33])
form.append('file', new Blob([fakeMp3], { type: 'audio/mpeg' }), 'test song.mp3')
form.append('durationMs', '180000')
form.append('memberId', welcomeA.memberId)
const upload = await fetch(`${base}/api/rooms/${roomId}/tracks`, { method: 'POST', body: form })
const track = await upload.json()
check('upload via proxy', upload.status === 201, `${upload.status} ${track.title}`)
const queueB = await b.next('queue')
check('other member receives queue', queueB.tracks[0]?.trackId === track.trackId)

const file = await fetch(`${base}${track.url}`)
check('download via proxy', file.status === 200 && (await file.arrayBuffer()).byteLength === 1000,
  file.headers.get('cache-control'))

const sentAt = performance.now()
a.send({ type: 'command', action: 'play' })
const [playA, playB] = await Promise.all([a.next('playback'), b.next('playback')])
const serverAtSend = sentAt + a.offset()
const lead = playA.state.effectiveAt - serverAtSend
check('play broadcast identical to both', JSON.stringify(playA) === JSON.stringify(playB), `rev ${playA.state.rev}`)
check('effectiveAt ≈ now + 1000 ms lead', Math.abs(lead - 1000) < 50, `${lead.toFixed(1)} ms`)

await sleep(1500)
b.send({ type: 'command', action: 'pause' })
const [pauseA, pauseB] = await Promise.all([a.next('playback'), b.next('playback')])
const expected = (pauseA.state.effectiveAt - playA.state.effectiveAt)
check('pause position = time played', Math.abs(pauseA.state.position - expected) < 0.001 &&
  pauseA.state.position === pauseB.state.position, `${pauseA.state.position.toFixed(1)} ms`)

b.send({ type: 'stats', offsetMs: b.offset(), rttMs: 1, driftMs: null, outputLatencyMs: null })
let members
do members = await a.next('members')
while (!members.members.some((m) => m.sync !== null))
const bob = members.members.find((m) => m.sync !== null)
check('members broadcast carries stats', members.members.length === 2 && bob.name === 'bob',
  `offset ${bob.sync.offsetMs.toFixed(2)} ms`)

a.ws.close()
b.ws.close()
let failed = 0
for (const r of results) {
  if (!r.ok) failed++
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`)
}
process.exit(failed ? 1 : 0)

import { HomePage } from './HomePage'
import { MetronomePage } from './MetronomePage'
import { RoomPage } from './RoomPage'
import { usePath } from './navigation'

export default function App() {
  const path = usePath()
  const room = /^\/r\/([^/]+)\/?$/.exec(path)
  if (room) {
    const roomId = decodeURIComponent(room[1])
    return <RoomPage key={roomId} roomId={roomId} />
  }
  if (path === '/debug/metronome') return <MetronomePage />
  return <HomePage />
}

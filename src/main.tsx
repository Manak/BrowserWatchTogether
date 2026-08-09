import { createRoot } from 'react-dom/client'
import { App } from './App'
import { prewarmIceServers } from './sync/iceServers'
import './styles.css'

const el = document.getElementById('root')
if (!el) throw new Error('missing #root')

// Fetch TURN credentials while somebody is still reading the lobby, so joining
// a room does not wait on a round trip it could have paid for earlier.
prewarmIceServers()

// Deliberately not wrapped in StrictMode: its development-only double-mount
// would join and leave the signalling relays twice with the same peer id,
// which confuses the other side of a real room.
createRoot(el).render(<App />)

import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const el = document.getElementById('root')
if (!el) throw new Error('missing #root')

// Deliberately not wrapped in StrictMode: its development-only double-mount
// would join and leave the signalling relays twice with the same peer id,
// which confuses the other side of a real room.
createRoot(el).render(<App />)

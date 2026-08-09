import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './App'
import { ROOM_CODE_RE } from './lib/roomCode'

// Stand in for the WebRTC transport so these tests never touch a network or
// the signalling relay. Mocked at the strategy, which is the seam where this
// app stops being pure UI.
vi.mock('./sync/relayStrategy', () => ({
  selfId: 'self-test-id',
  joinRoom: () => ({
    makeAction: () => ({ send: () => Promise.resolve(), onMessage: null }),
    leave: () => Promise.resolve(),
    getPeers: () => ({}),
    onPeerJoin: null,
    onPeerLeave: null,
  }),
}))

beforeEach(() => {
  localStorage.clear()
  location.hash = ''
})

describe('App flow', () => {
  it('asks for a name before anything else', () => {
    render(<App />)
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /start a new room/i })).toBeNull()
  })

  it('still demands a name when arriving through an invite link', () => {
    location.hash = '#/room/sunny-otter-42'
    render(<App />)
    expect(screen.getByLabelText(/your name/i)).toBeInTheDocument()
    expect(screen.getByText('sunny-otter-42')).toBeInTheDocument()
  })

  it('remembers the name and goes straight to the lobby next time', () => {
    localStorage.setItem('wt.name', 'Ada')
    render(<App />)
    expect(screen.getByRole('button', { name: /start a new room/i })).toBeInTheDocument()
    expect(screen.getByText(/hi ada/i)).toBeInTheDocument()
  })

  it('creates a room with a shareable code in the url', async () => {
    localStorage.setItem('wt.name', 'Ada')
    render(<App />)
    await userEvent.click(screen.getByRole('button', { name: /start a new room/i }))

    const code = location.hash.replace('#/room/', '')
    expect(code).toMatch(ROOM_CODE_RE)
    expect(
      await screen.findByRole('button', { name: new RegExp(`Room ${code}`) }),
    ).toBeInTheDocument()
  })

  it('rejects a malformed room code', async () => {
    localStorage.setItem('wt.name', 'Ada')
    render(<App />)
    await userEvent.type(screen.getByLabelText(/room code/i), 'xy')
    await userEvent.click(screen.getByRole('button', { name: /join room/i }))
    expect(screen.getByRole('alert')).toHaveTextContent(/does not look right/i)
  })

  it('enters an existing room by code', async () => {
    localStorage.setItem('wt.name', 'Ada')
    render(<App />)
    await userEvent.type(screen.getByLabelText(/room code/i), 'Sunny Otter 42')
    await userEvent.click(screen.getByRole('button', { name: /join room/i }))
    expect(location.hash).toBe('#/room/sunny-otter-42')
  })
})

/** The code also appears in the invite hint, so target the header chip. */
const findRoomChip = () =>
  screen.findByRole('button', { name: /Room sunny-otter-42/ })

describe('inside a room', () => {
  beforeEach(() => {
    localStorage.setItem('wt.name', 'Ada')
    location.hash = '#/room/sunny-otter-42'
  })

  it('shows the room code, the participant list and the empty state', async () => {
    render(<App />)
    expect(await findRoomChip()).toBeInTheDocument()
    expect(screen.getByText(/in this room \(1\)/i)).toBeInTheDocument()
    expect(screen.getByText('Ada')).toBeInTheDocument()
    expect(screen.getByText(/no video yet/i)).toBeInTheDocument()
  })

  it('marks the only participant as you', async () => {
    render(<App />)
    await findRoomChip()
    expect(screen.getByText('you')).toBeInTheDocument()
    expect(screen.getByText(/nobody else is here yet/i)).toBeInTheDocument()
  })

  it('disables transport controls until a video is chosen', async () => {
    render(<App />)
    await findRoomChip()
    expect(screen.getByRole('button', { name: /^play$/i })).toBeDisabled()
    expect(screen.getByLabelText(/seek/i)).toBeDisabled()
  })

  it('opens the video tab to add a link', async () => {
    render(<App />)
    await findRoomChip()
    await userEvent.click(screen.getByRole('button', { name: /add a video/i }))
    expect(screen.getByLabelText(/video link/i)).toBeInTheDocument()
  })

  it('leaves the room and returns to the lobby', async () => {
    render(<App />)
    await findRoomChip()
    await userEvent.click(screen.getByRole('button', { name: /leave room/i }))
    expect(
      await screen.findByRole('button', { name: /start a new room/i }),
    ).toBeInTheDocument()
    expect(location.hash).toBe('')
  })
})

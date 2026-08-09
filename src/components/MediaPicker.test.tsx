import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkDriveIsPublic } from '../lib/media'
import type * as DriveModule from '../lib/media'
import { MediaPicker } from './MediaPicker'

// The real probe loads an <img> from Google; stub it so the tests are offline
// and deterministic. Everything else in ../lib/media stays real.
vi.mock('../lib/media', async (importOriginal) => {
  const actual = await importOriginal<typeof DriveModule>()
  return { ...actual, checkDriveIsPublic: vi.fn() }
})

const probe = vi.mocked(checkDriveIsPublic)
const LINK = 'https://drive.google.com/file/d/1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUv/view'

beforeEach(() => probe.mockReset())

describe('MediaPicker', () => {
  it('rejects something that is not a link', async () => {
    const onPick = vi.fn()
    render(<MediaPicker name="Ada" selfId="me" current={null} onPick={onPick} />)

    await userEvent.type(screen.getByLabelText(/video link/i), 'not a link')
    await userEvent.click(screen.getByRole('button', { name: /load video/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/whole google drive url/i)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('explains that a folder link is not a video', async () => {
    render(<MediaPicker name="Ada" selfId="me" current={null} onPick={vi.fn()} />)
    await userEvent.type(
      screen.getByLabelText(/video link/i),
      'https://drive.google.com/drive/folders/1A2b3C4d5E6f7G8h9I0jKlMnOpQrStUv',
    )
    await userEvent.click(screen.getByRole('button', { name: /load video/i }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/folder link/i)
  })

  it('blocks a link that is not shared publicly and says how to fix it', async () => {
    const onPick = vi.fn()
    probe.mockResolvedValue({ status: 'not-public' })
    render(<MediaPicker name="Ada" selfId="me" current={null} onPick={onPick} />)

    await userEvent.type(screen.getByLabelText(/video link/i), LINK)
    await userEvent.click(screen.getByRole('button', { name: /load video/i }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/not shared publicly/i)
    expect(alert).toHaveTextContent(/Anyone with the link/i)
    expect(onPick).not.toHaveBeenCalled()
    expect(screen.getByRole('link', { name: /open this file in drive/i })).toHaveAttribute(
      'href',
      expect.stringContaining('drive.google.com/file/d/'),
    )
  })

  it('accepts a public link and hands back a playable url', async () => {
    const onPick = vi.fn()
    probe.mockResolvedValue({ status: 'public' })
    render(<MediaPicker name="Ada" selfId="me" current={null} onPick={onPick} />)

    await userEvent.type(screen.getByLabelText(/video link/i), LINK)
    await userEvent.type(screen.getByLabelText(/title/i), 'Our film')
    await userEvent.click(screen.getByRole('button', { name: /load video/i }))

    await vi.waitFor(() => expect(onPick).toHaveBeenCalled())
    const ref = onPick.mock.calls[0]![0]
    expect(ref).toMatchObject({ kind: 'drive', title: 'Our film', setBy: 'Ada' })
    expect(ref.url).toContain('drive.usercontent.google.com/download')
  })

  it('does not block when the permission probe is inconclusive', async () => {
    const onPick = vi.fn()
    probe.mockResolvedValue({ status: 'unknown' })
    render(<MediaPicker name="Ada" selfId="me" current={null} onPick={onPick} />)

    await userEvent.type(screen.getByLabelText(/video link/i), LINK)
    await userEvent.click(screen.getByRole('button', { name: /load video/i }))

    await vi.waitFor(() => expect(onPick).toHaveBeenCalled())
  })

  it('offers an override, since the probe is only advisory', async () => {
    const onPick = vi.fn()
    probe.mockResolvedValue({ status: 'not-public' })
    render(<MediaPicker name="Ada" selfId="me" current={null} onPick={onPick} />)

    await userEvent.type(screen.getByLabelText(/video link/i), LINK)
    await userEvent.click(screen.getByRole('button', { name: /load video/i }))
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('button', { name: /try it anyway/i }))

    expect(onPick).toHaveBeenCalledTimes(1)
  })

  it('skips the Drive permission probe for a plain direct url', async () => {
    const onPick = vi.fn()
    render(<MediaPicker name="Ada" selfId="me" current={null} onPick={onPick} />)

    await userEvent.type(
      screen.getByLabelText(/video link/i),
      'https://example.com/movie.mp4',
    )
    await userEvent.click(screen.getByRole('button', { name: /load video/i }))

    await vi.waitFor(() => expect(onPick).toHaveBeenCalled())
    expect(probe).not.toHaveBeenCalled()
  })
})

describe('MediaPicker, sharing a file from this computer', () => {
  it('offers the file picker on a desktop', () => {
    render(
      <MediaPicker
        name="Ada"
        selfId="me"
        current={null}
        onPick={vi.fn()}
        canShareFile
      />,
    )
    expect(
      screen.getByRole('button', { name: /file from this computer/i }),
    ).toBeInTheDocument()
  })

  it('explains itself instead of offering the picker on a phone', () => {
    render(
      <MediaPicker
        name="Ada"
        selfId="me"
        current={null}
        onPick={vi.fn()}
        canShareFile={false}
      />,
    )
    expect(
      screen.queryByRole('button', { name: /file from this computer/i }),
    ).not.toBeInTheDocument()
    // And says watching one is still fine, which is the part that matters.
    expect(screen.getByText(/somebody else is sharing works fine/i)).toBeInTheDocument()
  })

  it('hands back a ref naming us as the peer to fetch the bytes from', async () => {
    const onPick = vi.fn()
    render(
      <MediaPicker
        name="Ada"
        selfId="peer-a"
        current={null}
        onPick={onPick}
        canShareFile
      />,
    )

    const file = new File([new Uint8Array(2048)], 'holiday.mp4', { type: 'video/mp4' })
    await userEvent.upload(screen.getByLabelText(/file from this computer/i), file)

    await vi.waitFor(() => expect(onPick).toHaveBeenCalled())
    const ref = onPick.mock.calls[0]![0]
    expect(ref).toMatchObject({ kind: 'local', title: 'holiday.mp4', setBy: 'Ada' })
    expect(ref.share).toMatchObject({ hostId: 'peer-a', size: 2048, mime: 'video/mp4' })
    // The bytes never go on the wire with the descriptor.
    expect(ref.url).toBe('')
  })

  it('refuses a file that is not a video, without touching the room', async () => {
    const onPick = vi.fn()
    render(
      <MediaPicker
        name="Ada"
        selfId="peer-a"
        current={null}
        onPick={onPick}
        canShareFile
      />,
    )

    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' })
    // The input's `accept` would normally keep this out; the check behind it is
    // what a drag-and-drop or an odd platform runs into.
    await userEvent.upload(screen.getByLabelText(/file from this computer/i), file, {
      applyAccept: false,
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(/not a video file/i)
    expect(onPick).not.toHaveBeenCalled()
  })

  it('shares an mkv but warns that browsers will not decode it', async () => {
    const onPick = vi.fn()
    render(
      <MediaPicker
        name="Ada"
        selfId="peer-a"
        current={null}
        onPick={onPick}
        canShareFile
      />,
    )

    const file = new File([new Uint8Array(16)], 'film.mkv', { type: '' })
    await userEvent.upload(screen.getByLabelText(/file from this computer/i), file)

    await vi.waitFor(() => expect(onPick).toHaveBeenCalled())
    expect(await screen.findByRole('status')).toHaveTextContent(/cannot decode/i)
  })
})

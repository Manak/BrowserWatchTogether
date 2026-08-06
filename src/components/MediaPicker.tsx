import { useState } from 'react'
import {
  buildMediaRef,
  checkDriveIsPublic,
  drivePageUrl,
  hasEmbeddedCredential,
  parseMediaLink,
  type MediaRef,
} from '../lib/media'

interface Props {
  name: string
  current: MediaRef | null
  onPick: (ref: MediaRef) => void
  onCancel?: () => void
}

type Status =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string; fileId?: string; allowAnyway?: boolean }

export function MediaPicker({ name, current, onPick, onCancel }: Props) {
  const [link, setLink] = useState('')
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const commit = (parsed: ReturnType<typeof parseMediaLink>) => {
    if (!parsed.ok) return
    onPick(buildMediaRef(parsed, { title, setBy: name, setAt: Date.now() }))
    setLink('')
    setTitle('')
    setStatus({ kind: 'idle' })
  }

  const submit = async () => {
    const parsed = parseMediaLink(link)
    if (!parsed.ok) {
      setStatus({ kind: 'error', message: parsed.error })
      return
    }
    if (parsed.kind !== 'drive') {
      commit(parsed)
      return
    }

    setStatus({ kind: 'checking' })
    const check = await checkDriveIsPublic(parsed.fileId)
    if (check.status === 'not-public') {
      setStatus({
        kind: 'error',
        fileId: parsed.fileId,
        allowAnyway: true,
        message:
          'This file is not shared publicly. Open it in Drive, choose Share → General access → "Anyone with the link", then paste the link again.',
      })
      return
    }
    // 'unknown' means the probe timed out — the <video> element will give the
    // definitive answer a moment later, so do not block on it.
    commit(parsed)
  }

  return (
    <form
      className="picker"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label className="label" htmlFor="drive-link">
        Video link
      </label>
      <input
        id="drive-link"
        className="input"
        value={link}
        onChange={(e) => {
          setLink(e.target.value)
          setStatus({ kind: 'idle' })
        }}
        placeholder="Google Drive, put.io, or a direct video URL"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
      />

      <label className="label" htmlFor="drive-title">
        Title <span className="muted">(optional)</span>
      </label>
      <input
        id="drive-title"
        className="input"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={current ? current.title : 'Movie night'}
        maxLength={80}
      />

      {status.kind === 'error' && (
        <div className="error" role="alert">
          <p>{status.message}</p>
          {status.fileId && (
            <p>
              <a
                className="link"
                href={drivePageUrl(status.fileId)}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open this file in Drive
              </a>
            </p>
          )}
          {status.allowAnyway && (
            <button
              className="btn btn-small"
              type="button"
              onClick={() => commit(parseMediaLink(link))}
            >
              Try it anyway
            </button>
          )}
        </div>
      )}

      {hasEmbeddedCredential(link) && (
        <p className="warn" role="status">
          This link contains an access token. Everyone in the room receives the
          video link, so only use it with people you trust — and revoke the token
          afterwards if the link ever leaves this room.
        </p>
      )}

      <div className="row">
        <button
          className="btn btn-primary"
          type="submit"
          disabled={!link.trim() || status.kind === 'checking'}
        >
          {status.kind === 'checking' ? 'Checking…' : current ? 'Change video' : 'Load video'}
        </button>
        {onCancel && (
          <button className="btn" type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>

      <p className="footnote">
        Google Drive files must be shared as <strong>Anyone with the link</strong>.
        put.io links are switched to the converted MP4 automatically. MP4 (H.264 +
        AAC) plays everywhere; MKV and AVI generally do not play in browsers.
      </p>
    </form>
  )
}

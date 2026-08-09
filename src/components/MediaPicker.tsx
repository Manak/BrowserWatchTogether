import { useRef, useState } from 'react'
import { canShareLocalFile } from '../lib/device'
import { formatBytes } from '../lib/format'
import {
  buildMediaRef,
  checkDriveIsPublic,
  drivePageUrl,
  hasEmbeddedCredential,
  parseMediaLink,
  type MediaRef,
} from '../lib/media'
import { fetchYouTubeTitle } from '../lib/youtube'
import { shareLocalFile } from '../share/shareFile'

interface Props {
  name: string
  /** Our own peer id: it goes in the share so peers know whom to ask. */
  selfId: string
  current: MediaRef | null
  onPick: (ref: MediaRef) => void
  onCancel?: () => void
  /**
   * Overridable so the desktop-only gate can be tested both ways; production
   * always uses the real feature test.
   */
  canShareFile?: boolean
}

type Status =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'error'; message: string; fileId?: string; allowAnyway?: boolean }

export function MediaPicker({
  name,
  selfId,
  current,
  onPick,
  onCancel,
  canShareFile,
}: Props) {
  const [link, setLink] = useState('')
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [fileWarning, setFileWarning] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const canShare = canShareFile ?? canShareLocalFile()

  const commit = (parsed: ReturnType<typeof parseMediaLink>, resolvedTitle?: string) => {
    if (!parsed.ok) return
    onPick(
      buildMediaRef(parsed, {
        title: title || resolvedTitle,
        setBy: name,
        setAt: Date.now(),
      }),
    )
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
    if (parsed.kind === 'youtube') {
      // The real title comes from YouTube's public oEmbed endpoint. It is a
      // nicety, so it gets one short attempt and never blocks the video.
      setStatus({ kind: 'checking' })
      const fetched = title ? null : await fetchYouTubeTitle(parsed.videoId)
      commit(parsed, fetched ?? undefined)
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

  /**
   * A file picked off this machine. Nothing is uploaded anywhere: it is
   * registered locally, and the descriptor that goes to the room is how the
   * others know whom to ask for the bytes.
   */
  const pickFile = (file: File | undefined) => {
    setFileWarning(null)
    if (!file) return
    const attempt = shareLocalFile(file, { selfId, name, title })
    if (!attempt.ok) {
      setStatus({ kind: 'error', message: attempt.error })
      return
    }
    setFileWarning(attempt.warning)
    setStatus({ kind: 'idle' })
    onPick(attempt.ref)
    setLink('')
    setTitle('')
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
        placeholder="YouTube, Google Drive, put.io, or a direct video URL"
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

      <div className="picker-or">
        <span>or</span>
      </div>

      {canShare ? (
        <div className="share-file">
          <input
            ref={fileInput}
            className="visually-hidden"
            type="file"
            // The button next to it is what people click; this carries the name
            // so the input is still reachable on its own terms.
            aria-label="Play a file from this computer"
            accept="video/*,.mp4,.m4v,.webm,.mov,.mkv"
            onChange={(e) => {
              pickFile(e.target.files?.[0])
              // Cleared so picking the same file twice still fires a change.
              e.target.value = ''
            }}
          />
          <button
            className="btn btn-block"
            type="button"
            onClick={() => fileInput.current?.click()}
          >
            Play a file from this computer
          </button>
          {current?.kind === 'local' && current.share && (
            <p className="footnote">
              Sharing <strong>{current.share.name}</strong> (
              {formatBytes(current.share.size)}). Keep this tab open — the video
              is coming from this computer.
            </p>
          )}
          {fileWarning && (
            <p className="warn" role="status">
              {fileWarning}
            </p>
          )}
          <p className="footnote">
            The file is sent straight to the people in this room over the same
            connection as everything else. It is never uploaded anywhere, and it
            plays for as long as this tab stays open and in the room.
          </p>
        </div>
      ) : (
        <p className="footnote">
          A file from this device cannot be shared from a phone or tablet:
          sharing means uploading the whole film to each person for as long as it
          runs, and a phone suspends the tab the moment you look away. Watching
          one that somebody else is sharing works fine here.
        </p>
      )}

      <p className="footnote">
        YouTube plays in its own embed, so everyone sees their own ads — the room
        pauses for whoever is watching one and starts again together. Google Drive
        files must be shared as <strong>Anyone with the link</strong>. put.io links
        are switched to the converted MP4 automatically. MP4 (H.264 + AAC) plays
        everywhere; MKV and AVI generally do not play in browsers.
      </p>
    </form>
  )
}

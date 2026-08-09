import { useEffect, useState } from 'react'
import {
  collectDiagnostics,
  summarise,
  type Diagnostics,
} from '../sync/diagnostics'

interface Props {
  connections: () => Record<string, RTCPeerConnection>
  connected: boolean
  joinError: string | null
}

/**
 * Why the room is not connecting, in enough detail to act on.
 *
 * Folded away, because nobody wants this on a good day. It exists because the
 * failures it describes are indistinguishable from each other on screen —
 * "can't reach them" covers a blocked STUN, a symmetric NAT and a peer that
 * simply left — and they need different fixes. Guessing between them from a
 * description has cost two rounds already.
 *
 * The copy button is the point: this has to come off a phone, where a tooltip
 * cannot be read and a console does not exist.
 */
export function ConnectionDetails({ connections, connected, joinError }: Props) {
  const [open, setOpen] = useState(false)
  const [diag, setDiag] = useState<Diagnostics | null>(null)
  const [copied, setCopied] = useState(false)

  // Only polls while it is open: getStats on every connection every two
  // seconds is not a thing to do in the background of a film.
  useEffect(() => {
    if (!open) return
    let live = true
    const read = () => {
      void collectDiagnostics(connections()).then((d) => {
        if (live) setDiag(d)
      })
    }
    read()
    const timer = setInterval(read, 2000)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [open, connections])

  const report = diag ? asText(diag, connected, joinError) : ''

  return (
    <details
      className="diagnostics"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary>Connection details</summary>

      {joinError && (
        <p className="diagnostics-error" role="status">
          {joinError}
        </p>
      )}

      {diag ? (
        <>
          <p className="diagnostics-verdict">{summarise(diag, connected)}</p>
          <pre className="diagnostics-body">{report}</pre>
          <button
            className="btn btn-small"
            type="button"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(report)
                .then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 2000)
                })
                .catch(() => {
                  /* clipboard denied; the text is on screen to select */
                })
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </>
      ) : (
        <p className="footnote">Reading…</p>
      )}
    </details>
  )
}

function asText(d: Diagnostics, connected: boolean, joinError: string | null): string {
  const lines = [
    summarise(d, connected),
    `connected: ${connected}`,
    `candidates gathered: ${d.gathered.join(', ') || 'none'}`,
  ]
  if (joinError) lines.push(`last error: ${joinError}`)
  for (const p of d.peers) {
    lines.push(
      `peer ${p.peerId}: connection=${p.connection} ice=${p.ice} gathering=${p.gathering}` +
        (p.localType ? ` via ${p.localType}->${p.remoteType}` : ''),
    )
  }
  return lines.join('\n')
}

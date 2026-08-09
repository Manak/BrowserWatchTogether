import { buildLocalMediaRef, checkLocalFile, type MediaRef } from '../lib/media'
import { fileHost } from './fileHost'

/**
 * Register a file off this disk and produce the descriptor the room will see.
 *
 * There are two ways in — the button in the picker and dropping a file on the
 * player — and they must agree about what is playable, what is merely risky,
 * and who is serving it. So both go through here rather than each doing their
 * own version of it.
 */

export type ShareAttempt =
  | { ok: true; ref: MediaRef; warning: string | null }
  | { ok: false; error: string }

export function shareLocalFile(
  file: File,
  opts: { selfId: string; name: string; title?: string; now?: () => number },
): ShareAttempt {
  const check = checkLocalFile(file)
  if (!check.ok) return { ok: false, error: check.error }

  return {
    ok: true,
    warning: check.warning,
    ref: buildLocalMediaRef(fileHost.add(file, opts.selfId), {
      title: opts.title,
      setBy: opts.name,
      setAt: (opts.now ?? Date.now)(),
    }),
  }
}

/**
 * The first video in a drag, if there is one.
 *
 * A drag can carry several files, a directory, or a selection from another
 * page; taking the first video and ignoring the rest is friendlier than
 * refusing the whole drop, and the room can only play one thing anyway.
 */
export function firstVideoFile(items: FileList | null): File | null {
  if (!items || items.length === 0) return null
  for (const file of items) {
    if (checkLocalFile(file).ok) return file
  }
  // Nothing passed, so hand back the first one and let the caller explain why
  // it was refused — "that is not a video" beats a drop that does nothing.
  return items[0] ?? null
}

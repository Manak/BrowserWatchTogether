import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * Dropping a file on the player.
 *
 * The fiddly part is knowing when the drag has actually left: `dragleave` fires
 * every time the pointer crosses into a child element, so a naive flag flickers
 * off and on as the cursor moves over the controls. Counting enters against
 * leaves is the standard fix and the reason this is a hook rather than four
 * inline handlers.
 *
 * Listeners are attached to the element rather than the window so that a drag
 * onto the rest of the page — the room code, the panel — is left alone.
 */
export function useFileDrop(
  ref: RefObject<HTMLElement | null>,
  onDrop: (files: FileList) => void,
  enabled: boolean,
): { dragging: boolean } {
  const [dragging, setDragging] = useState(false)
  // Held in a ref so the handlers never need re-binding mid-drag.
  const depth = useRef(0)
  const handler = useRef(onDrop)
  useEffect(() => {
    handler.current = onDrop
  }, [onDrop])

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return

    /** True only for a drag carrying files, not for selected text or a link. */
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files')

    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current++
      setDragging(true)
    }
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return
      // Without this the browser navigates to the file instead of dropping it.
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth.current = Math.max(0, depth.current - 1)
      if (depth.current === 0) setDragging(false)
    }
    const onDropped = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth.current = 0
      setDragging(false)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) handler.current(files)
    }

    el.addEventListener('dragenter', onEnter)
    el.addEventListener('dragover', onOver)
    el.addEventListener('dragleave', onLeave)
    el.addEventListener('drop', onDropped)
    return () => {
      el.removeEventListener('dragenter', onEnter)
      el.removeEventListener('dragover', onOver)
      el.removeEventListener('dragleave', onLeave)
      el.removeEventListener('drop', onDropped)
      depth.current = 0
    }
  }, [ref, enabled])

  return { dragging: dragging && enabled }
}

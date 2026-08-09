import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * A guard against silently losing style rules.
 *
 * This stylesheet has twice been edited by script, and twice a slice-and-
 * replace removed rules that happened to sit between the two anchors — once
 * taking `.video` with it, which left the player rendering at the video's
 * intrinsic size and blowing the whole page out of the viewport. Nothing in
 * typecheck, lint or the component tests noticed, because a missing CSS rule
 * is not an error anywhere.
 *
 * These are the rules whose absence breaks layout rather than merely looking
 * wrong. It is a smoke alarm, not a design review.
 */
// Vitest runs from the project root; import.meta.url is rewritten by the
// transform and is not a usable file path here.
const css = readFileSync(join(process.cwd(), 'src/styles.css'), 'utf8')

/** Selectors that must exist, with a property that must appear inside them. */
const REQUIRED: [selector: string, property: string][] = [
  // Without this the video renders at its intrinsic size — a 4K file makes the
  // page thousands of pixels wide.
  ['.video', 'object-fit'],
  ['.player', 'position'],
  ['.stage', 'position'],
  // The YouTube embed has no intrinsic sizing of its own: unstyled, the iframe
  // falls back to the API's default 640x390 and sits in the corner of a black
  // stage. The shield must cover the frame exactly, or clicks reach YouTube's
  // player and pause one screen out of two.
  ['.yt-stage', 'position'],
  ['.yt-shield', 'position'],
  ['.controls', 'background'],
  // Overlays carry every empty and error state; unstyled they lose their
  // backdrop and sit as bare text over the film.
  ['.overlay', 'position'],
  ['.overlay-title', 'font-weight'],
  ['.overlay-sub', 'color'],
  ['.spinner', 'animation'],
  ['.toasts', 'position'],
  ['.toast', 'border-radius'],
  ['.people', 'list-style'],
  ['.person', 'display'],
  ['.panel', 'display'],
  ['.topbar', 'display'],
  ['.screen', 'min-height'],
  ['.card', 'border-radius'],
  ['.btn', 'min-height'],
  ['.btn-icon', 'border-radius'],
  ['.input', 'font-size'],
  ['.scrub-track', 'position'],
  ['.scrub-input', 'position'],
  // The file input is hidden behind a button; without this it is visible, and
  // an unstyled file input in the middle of the picker looks like a bug.
  ['.visually-hidden', 'position'],
  ['.player-drop', 'outline'],
  ['.diagnostics', 'border-radius'],
  ['.diagnostics-body', 'overflow-x'],
  ['.share-bar', 'overflow'],
  ['.share-bar-fill', 'background'],
]

/** Extract the declaration block for a selector, if it has one. */
function ruleBody(selector: string): string | null {
  // Match the selector as a whole token at the start of a rule.
  const pattern = new RegExp(
    `(^|[,}])\\s*\\${selector}\\s*(,[^{]*)?\\{([^}]*)\\}`,
    'm',
  )
  const match = pattern.exec(css)
  return match ? (match[3] ?? null) : null
}

describe('styles.css', () => {
  it.each(REQUIRED)('defines %s with %s', (selector, property) => {
    const body = ruleBody(selector)
    expect(body, `${selector} is missing from styles.css`).not.toBeNull()
    expect(body).toContain(property)
  })

  it('keeps the video constrained to its container', () => {
    const body = ruleBody('.video') as string
    expect(body).toMatch(/width:\s*100%/)
    expect(body).toMatch(/height:\s*100%/)
  })

  it('styles fullscreen from the browser selector, not a stateful class', () => {
    // A class driven by React state can be wrong; :fullscreen cannot.
    expect(css).toMatch(/\.player:fullscreen/)
  })

  it('has balanced braces', () => {
    const open = (css.match(/\{/g) ?? []).length
    const close = (css.match(/\}/g) ?? []).length
    expect(open).toBe(close)
  })
})

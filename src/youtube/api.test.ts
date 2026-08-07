import { describe, expect, it } from 'vitest'
import { defaultPlayerVars } from './api'

describe('player parameters', () => {
  /**
   * The room owns the controls, because YouTube's belong to whoever's screen
   * they are on: a scrub there moves that person alone and desyncs everyone
   * else with nothing on screen to explain it.
   */
  it('hides YouTube’s controls by default', () => {
    const vars = defaultPlayerVars('https://example.com')
    expect(vars.controls).toBe(0)
    expect(vars.fs).toBe(0)
  })

  /**
   * Except where our own fullscreen button cannot work — an iPhone, which has
   * no Fullscreen API for anything but a <video>, and the only <video> here is
   * inside a cross-origin iframe. YouTube's fullscreen button is the sole way
   * in, and it only exists as part of its control bar.
   */
  it('gives the controls back where fullscreen depends on them', () => {
    const vars = defaultPlayerVars('https://example.com', { nativeControls: true })
    expect(vars.controls).toBe(1)
    expect(vars.fs).toBe(1)
  })

  it('always plays inline and always identifies its origin', () => {
    for (const opts of [{}, { nativeControls: true }]) {
      const vars = defaultPlayerVars('https://example.com', opts)
      // Without playsinline, iOS hijacks the screen the moment playback starts.
      expect(vars.playsinline).toBe(1)
      expect(vars.origin).toBe('https://example.com')
      expect(vars.enablejsapi).toBe(1)
    }
  })
})

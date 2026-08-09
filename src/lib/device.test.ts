import { afterEach, describe, expect, it, vi } from 'vitest'
import { canShareLocalFile } from './device'

/**
 * The gate is on *sharing*, never on watching. These tests exist mostly to
 * pin that down: a phone must keep answering true to nothing here, because
 * receiving a shared file is the thing phones are meant to do.
 */
function pretendDevice(opts: { coarse: boolean; touchPoints: number }): void {
  // jsdom implements neither of these, so they are defined rather than spied on.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) =>
      ({
        matches: query.includes('coarse') ? opts.coarse : false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  })
  Object.defineProperty(navigator, 'maxTouchPoints', {
    configurable: true,
    value: opts.touchPoints,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'matchMedia')
  Reflect.deleteProperty(navigator, 'maxTouchPoints')
})

describe('canShareLocalFile', () => {
  it('allows a laptop with a mouse', () => {
    pretendDevice({ coarse: false, touchPoints: 0 })
    expect(canShareLocalFile()).toBe(true)
  })

  it('refuses a phone', () => {
    pretendDevice({ coarse: true, touchPoints: 5 })
    expect(canShareLocalFile()).toBe(false)
  })

  it('refuses an iPad, which claims to be a desktop Safari', () => {
    pretendDevice({ coarse: true, touchPoints: 5 })
    expect(canShareLocalFile()).toBe(false)
  })

  it('allows a touchscreen laptop, which has a real pointer as well', () => {
    // Windows laptops with a touch display report touch points but a fine
    // pointer. They have none of the reasons the gate exists for.
    pretendDevice({ coarse: false, touchPoints: 10 })
    expect(canShareLocalFile()).toBe(true)
  })
})

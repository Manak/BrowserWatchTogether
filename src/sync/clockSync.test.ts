import { describe, expect, it } from 'vitest'
import { ClockSync } from './clockSync'

describe('ClockSync', () => {
  it('returns a zero offset for peers it has never measured', () => {
    const cs = new ClockSync()
    expect(cs.offsetTo('nobody')).toBe(0)
    expect(cs.rttTo('nobody')).toBeNull()
    expect(cs.has('nobody')).toBe(false)
  })

  it('recovers a known offset from a symmetric round trip', () => {
    const cs = new ClockSync()
    // Peer clock is 5000ms ahead; 100ms round trip, evenly split.
    const t0 = 1000
    const t1 = t0 + 50 + 5000
    const t3 = t0 + 100
    cs.addSample('p', t0, t1, t3)
    expect(cs.offsetTo('p')).toBeCloseTo(5000, 6)
    expect(cs.rttTo('p')).toBe(100)
  })

  it('prefers the lowest-latency sample over later noisy ones', () => {
    const cs = new ClockSync()
    // Clean sample: true offset 200.
    cs.addSample('p', 0, 200 + 10, 20)
    // Badly delayed sample that would imply a very different offset.
    cs.addSample('p', 100, 200 + 100 + 900, 1200)
    expect(cs.offsetTo('p')).toBeCloseTo(200, 6)
    expect(cs.rttTo('p')).toBe(20)
  })

  it('drops samples outside the window', () => {
    const cs = new ClockSync(2)
    cs.addSample('p', 0, 5, 10) // rtt 10, offset 0
    cs.addSample('p', 0, 1000, 1000) // rtt 1000
    cs.addSample('p', 0, 1000, 1000) // rtt 1000 — pushes the good one out
    expect(cs.rttTo('p')).toBe(1000)
  })

  it('ignores impossible (negative rtt) samples', () => {
    const cs = new ClockSync()
    cs.addSample('p', 100, 100, 50)
    expect(cs.has('p')).toBe(false)
  })

  it('converts between clocks consistently', () => {
    const cs = new ClockSync()
    cs.addSample('p', 0, 1250, 500) // offset = 1250 - 250 = 1000
    expect(cs.offsetTo('p')).toBe(1000)
    expect(cs.toPeerClock('p', 10_000)).toBe(11_000)
    expect(cs.toLocalClock('p', 11_000)).toBe(10_000)
  })

  it('forgets peers on request', () => {
    const cs = new ClockSync()
    cs.addSample('p', 0, 5, 10)
    cs.forget('p')
    expect(cs.has('p')).toBe(false)
    expect(cs.offsetTo('p')).toBe(0)
  })

  it('tracks peers independently', () => {
    const cs = new ClockSync()
    cs.addSample('a', 0, 100, 0)
    cs.addSample('b', 0, -100, 0)
    expect(cs.offsetTo('a')).toBe(100)
    expect(cs.offsetTo('b')).toBe(-100)
  })
})

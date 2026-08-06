import { describe, expect, it } from 'vitest'
import { bufferedAhead, computeCorrection, type DriftInput } from './drift'
import { TUNING } from './protocol'

const base: DriftInput = {
  localTime: 100,
  targetTime: 100,
  advancing: true,
  sinceSeekMs: 10_000,
}

const correct = (over: Partial<DriftInput>) =>
  computeCorrection({ ...base, ...over }, TUNING)

describe('computeCorrection while playing', () => {
  it('does nothing inside the deadband', () => {
    expect(correct({ localTime: 100.1 })).toEqual({ kind: 'none', rate: 1 })
    expect(correct({ localTime: 99.9 })).toEqual({ kind: 'none', rate: 1 })
  })

  it('slows down when we are ahead', () => {
    const c = correct({ localTime: 101 })
    expect(c.kind).toBe('rate')
    expect(c.rate).toBeLessThan(1)
    expect(c.rate).toBeGreaterThanOrEqual(1 - TUNING.maxRateDelta)
  })

  it('speeds up when we are behind', () => {
    const c = correct({ localTime: 99 })
    expect(c.kind).toBe('rate')
    expect(c.rate).toBeGreaterThan(1)
    expect(c.rate).toBeLessThanOrEqual(1 + TUNING.maxRateDelta)
  })

  it('never exceeds the perceptibility clamp', () => {
    for (let d = -TUNING.hardSeekSec; d <= TUNING.hardSeekSec; d += 0.05) {
      const c = correct({ localTime: 100 + d })
      expect(c.rate).toBeGreaterThanOrEqual(1 - TUNING.maxRateDelta - 1e-9)
      expect(c.rate).toBeLessThanOrEqual(1 + TUNING.maxRateDelta + 1e-9)
    }
  })

  it('hard seeks past the rate-correction band', () => {
    const c = correct({ localTime: 100 + TUNING.hardSeekSec + 0.5 })
    expect(c.kind).toBe('seek')
    expect(c.seekTo).toBe(100)
    expect(c.rate).toBe(1)
  })

  it('hard seeks stay well inside the 3-5s tolerance budget', () => {
    expect(TUNING.hardSeekSec).toBeLessThan(3)
  })

  it('suppresses corrections while the element settles after a seek', () => {
    expect(correct({ localTime: 105, sinceSeekMs: 100 })).toEqual({
      kind: 'none',
      rate: 1,
    })
  })
})

describe('computeCorrection while paused', () => {
  it('snaps to the target when out of place', () => {
    const c = correct({ advancing: false, localTime: 105, targetTime: 100 })
    expect(c).toEqual({ kind: 'seek', rate: 1, seekTo: 100 })
  })

  it('leaves an already-correct paused element alone', () => {
    const c = correct({ advancing: false, localTime: 100.05 })
    expect(c).toEqual({ kind: 'none', rate: 1 })
  })

  it('ignores the settle window when paused', () => {
    const c = correct({ advancing: false, localTime: 200, sinceSeekMs: 0 })
    expect(c.kind).toBe('seek')
  })
})

describe('seek clamping', () => {
  it('never seeks before zero', () => {
    const c = correct({ advancing: false, localTime: 0, targetTime: -30 })
    expect(c.seekTo).toBe(0)
  })

  it('never seeks past the end', () => {
    const c = correct({
      advancing: false,
      localTime: 0,
      targetTime: 500,
      duration: 100,
    })
    expect(c.seekTo).toBeCloseTo(99.95, 5)
  })

  it('ignores a non-finite duration', () => {
    const c = correct({
      advancing: false,
      localTime: 0,
      targetTime: 50,
      duration: Infinity,
    })
    expect(c.seekTo).toBe(50)
  })
})

describe('convergence', () => {
  it('drives drift to zero without overshooting', () => {
    let local = 103 // 3s ahead -> first move is a hard seek
    let target = 100
    const dt = 0.25
    for (let i = 0; i < 400; i++) {
      const c = computeCorrection(
        { localTime: local, targetTime: target, advancing: true, sinceSeekMs: 9999 },
        TUNING,
      )
      if (c.kind === 'seek') local = c.seekTo as number
      else local += dt * c.rate
      target += dt
    }
    expect(Math.abs(local - target)).toBeLessThanOrEqual(TUNING.deadbandSec + 0.05)
  })
})

function ranges(pairs: [number, number][]) {
  return {
    length: pairs.length,
    start: (i: number) => pairs[i]![0],
    end: (i: number) => pairs[i]![1],
  }
}

describe('bufferedAhead', () => {
  it('returns the remainder of the range containing the playhead', () => {
    expect(bufferedAhead(ranges([[0, 30]]), 10)).toBe(20)
  })

  it('picks the right range when there are several', () => {
    expect(bufferedAhead(ranges([[0, 10], [50, 90]]), 60)).toBe(30)
  })

  it('returns zero when the playhead is in a gap', () => {
    expect(bufferedAhead(ranges([[0, 10], [50, 90]]), 30)).toBe(0)
  })

  it('returns zero with no buffered ranges', () => {
    expect(bufferedAhead(ranges([]), 5)).toBe(0)
  })

  it('tolerates the playhead sitting just before a range edge', () => {
    expect(bufferedAhead(ranges([[10, 20]]), 9.9)).toBeCloseTo(10.1, 5)
  })
})

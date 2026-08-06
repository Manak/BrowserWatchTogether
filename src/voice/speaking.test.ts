import { describe, expect, it } from 'vitest'
import { SPEAKING_DEFAULTS, SpeakingDetector, rmsOf } from './speaking'

const OPTS = { threshold: 0.05, attackMs: 100, releaseMs: 400 }

describe('SpeakingDetector', () => {
  it('starts silent', () => {
    expect(new SpeakingDetector(OPTS).isSpeaking).toBe(false)
  })

  it('ignores a brief spike shorter than the attack window', () => {
    const d = new SpeakingDetector(OPTS)
    d.push(0.9, 0)
    expect(d.push(0.0, 50)).toBe(false)
  })

  it('reports speaking once the level holds for the attack window', () => {
    const d = new SpeakingDetector(OPTS)
    d.push(0.9, 0)
    expect(d.push(0.9, 99)).toBe(false)
    expect(d.push(0.9, 100)).toBe(true)
  })

  it('holds through short gaps between words', () => {
    const d = new SpeakingDetector(OPTS)
    d.push(0.9, 0)
    d.push(0.9, 100)
    expect(d.isSpeaking).toBe(true)
    // A 300ms pause is shorter than the release window.
    d.push(0.0, 200)
    expect(d.push(0.0, 500)).toBe(true)
  })

  it('goes silent once the gap exceeds the release window', () => {
    const d = new SpeakingDetector(OPTS)
    d.push(0.9, 0)
    d.push(0.9, 100)
    d.push(0.0, 200)
    expect(d.push(0.0, 600)).toBe(false)
  })

  it('restarts the release timer if the voice returns', () => {
    const d = new SpeakingDetector(OPTS)
    d.push(0.9, 0)
    d.push(0.9, 100)
    d.push(0.0, 200) // release pending, 400ms to go
    d.push(0.9, 300) // speech returns and cancels it

    // Silence is only observed again at 650, so the 400ms release starts there.
    expect(d.push(0.0, 650)).toBe(true)
    expect(d.push(0.0, 900)).toBe(true)
    expect(d.push(0.0, 1050)).toBe(false)
  })

  it('treats a level exactly at the threshold as voice', () => {
    const d = new SpeakingDetector(OPTS)
    d.push(0.05, 0)
    expect(d.push(0.05, 100)).toBe(true)
  })

  it('reacts faster to speech starting than to it stopping', () => {
    expect(SPEAKING_DEFAULTS.attackMs).toBeLessThan(SPEAKING_DEFAULTS.releaseMs)
  })

  it('resets to silence', () => {
    const d = new SpeakingDetector(OPTS)
    d.push(0.9, 0)
    d.push(0.9, 100)
    d.reset()
    expect(d.isSpeaking).toBe(false)
  })

  it('ignores steady room tone below the threshold', () => {
    const d = new SpeakingDetector(OPTS)
    for (let t = 0; t < 5000; t += 50) d.push(0.02, t)
    expect(d.isSpeaking).toBe(false)
  })
})

describe('rmsOf', () => {
  it('is zero for silence', () => {
    expect(rmsOf(new Float32Array(128))).toBe(0)
  })

  it('is zero for an empty buffer', () => {
    expect(rmsOf(new Float32Array(0))).toBe(0)
  })

  it('is the amplitude for a constant signal', () => {
    expect(rmsOf(new Float32Array(64).fill(0.5))).toBeCloseTo(0.5, 6)
  })

  it('ignores sign', () => {
    const a = new Float32Array([0.5, -0.5, 0.5, -0.5])
    expect(rmsOf(a)).toBeCloseTo(0.5, 6)
  })

  it('is ~0.707 of peak for a full-scale sine', () => {
    const n = 1024
    const buf = new Float32Array(n)
    for (let i = 0; i < n; i++) buf[i] = Math.sin((2 * Math.PI * i) / n)
    expect(rmsOf(buf)).toBeCloseTo(Math.SQRT1_2, 2)
  })
})

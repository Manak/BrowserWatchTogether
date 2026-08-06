import { describe, expect, it } from 'vitest'
import { colorForId, formatTime, initials, sanitizeName } from './format'

describe('formatTime', () => {
  it.each([
    [0, '0:00'],
    [5, '0:05'],
    [65, '1:05'],
    [600, '10:00'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3725, '1:02:05'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatTime(input)).toBe(expected)
  })

  it('is safe for NaN / negative / Infinity', () => {
    expect(formatTime(NaN)).toBe('0:00')
    expect(formatTime(-4)).toBe('0:00')
    expect(formatTime(Infinity)).toBe('0:00')
  })
})

describe('colorForId', () => {
  it('is deterministic', () => {
    expect(colorForId('abc')).toBe(colorForId('abc'))
  })
  it('differs between ids', () => {
    expect(colorForId('abc')).not.toBe(colorForId('abd'))
  })
})

describe('initials', () => {
  it.each([
    ['Ada Lovelace', 'AL'],
    ['ada', 'AD'],
    ['a', 'A'],
    ['  Grace  Brewster  Hopper ', 'GH'],
    ['', '?'],
  ])('maps %s to %s', (input, expected) => {
    expect(initials(input)).toBe(expected)
  })
})

describe('sanitizeName', () => {
  it('collapses whitespace and trims', () => {
    expect(sanitizeName('  Ada   Lovelace  ')).toBe('Ada Lovelace')
  })
  it('caps the length', () => {
    expect(sanitizeName('x'.repeat(80))).toHaveLength(24)
  })
})

import { describe, expect, it } from 'vitest'
import {
  ROOM_CODE_RE,
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  roomCodeFromHash,
  roomUrl,
} from './roomCode'

describe('generateRoomCode', () => {
  it('produces codes in word-word-number form', () => {
    for (let i = 0; i < 200; i++) {
      expect(generateRoomCode()).toMatch(ROOM_CODE_RE)
    }
  })

  it('produces varied codes', () => {
    const seen = new Set(Array.from({ length: 200 }, generateRoomCode))
    expect(seen.size).toBeGreaterThan(150)
  })

  it('always generates codes it considers valid', () => {
    for (let i = 0; i < 50; i++) {
      expect(isValidRoomCode(generateRoomCode())).toBe(true)
    }
  })
})

describe('normalizeRoomCode', () => {
  it.each([
    ['  Sunny-Otter-42 ', 'sunny-otter-42'],
    ['Sunny Otter 42', 'sunny-otter-42'],
    ['sunny_otter_42', 'sunny-otter-42'],
    ['SUNNY--OTTER--42', 'sunny-otter-42'],
    ['sunny-otter-42!', 'sunny-otter-42'],
    ['-sunny-otter-42-', 'sunny-otter-42'],
  ])('normalises %s', (input, expected) => {
    expect(normalizeRoomCode(input)).toBe(expected)
  })

  it('extracts the code from a pasted share link', () => {
    expect(
      normalizeRoomCode('https://foo.github.io/watch/#/room/sunny-otter-42'),
    ).toBe('sunny-otter-42')
  })
})

describe('isValidRoomCode', () => {
  it('accepts generated and reasonable custom codes', () => {
    expect(isValidRoomCode('sunny-otter-42')).toBe(true)
    expect(isValidRoomCode('our-movie-night')).toBe(true)
  })

  it('rejects codes that are too short to be private', () => {
    expect(isValidRoomCode('ab')).toBe(false)
    expect(isValidRoomCode('')).toBe(false)
  })

  it('rejects codes with characters normalisation would have stripped', () => {
    expect(isValidRoomCode('Sunny Otter')).toBe(false)
  })
})

describe('roomUrl / roomCodeFromHash', () => {
  it('round-trips a code through a share url', () => {
    const url = roomUrl('sunny-otter-42', 'https://foo.github.io/watch/')
    expect(url).toBe('https://foo.github.io/watch/#/room/sunny-otter-42')
    expect(roomCodeFromHash(new URL(url).hash)).toBe('sunny-otter-42')
  })

  it('drops an existing hash from the origin', () => {
    expect(roomUrl('a-b-12', 'https://x.dev/app/#/room/old')).toBe(
      'https://x.dev/app/#/room/a-b-12',
    )
  })

  it('returns null for hashes that are not room links', () => {
    expect(roomCodeFromHash('')).toBeNull()
    expect(roomCodeFromHash('#/about')).toBeNull()
    expect(roomCodeFromHash('#/room/ab')).toBeNull()
  })
})

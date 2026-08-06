import { sharedAudioContext } from './browserAudio'

/**
 * Short synthesised tones for arrivals and departures.
 *
 * Generated rather than loaded: a two-note blip is a few lines of oscillator,
 * where a sound file would be a network request, a cache entry, and something
 * else to get wrong on a flaky connection.
 *
 * These deliberately go through the same AudioContext as everything else and
 * are mixed at a low level — nothing here touches the video's volume.
 */

/** Quiet enough to sit under dialogue rather than over it. */
const PEAK = 0.12
const ATTACK = 0.01
const RELEASE = 0.14

/** Rising two-note figure: someone arrived. */
const JOIN_NOTES = [660, 880]
/** Falling, so it reads as a departure without needing to be read at all. */
const LEAVE_NOTES = [560, 400]

export type ChimeKind = 'join' | 'leave'

/**
 * Play the chime. Silent, without throwing, when the browser has not given us
 * an audio context yet — the tone is a nicety and must never break a render.
 */
export function playChime(kind: ChimeKind): void {
  const ctx = sharedAudioContext()
  if (!ctx) return
  try {
    const notes = kind === 'join' ? JOIN_NOTES : LEAVE_NOTES
    notes.forEach((frequency, i) => {
      const startAt = ctx.currentTime + i * 0.11
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      // A triangle is softer than a square and less piercing than a sine at
      // these frequencies.
      osc.type = 'triangle'
      osc.frequency.value = frequency
      // Ramped rather than switched, because an instant start or stop clicks.
      gain.gain.setValueAtTime(0, startAt)
      gain.gain.linearRampToValueAtTime(PEAK, startAt + ATTACK)
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + ATTACK + RELEASE)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(startAt)
      osc.stop(startAt + ATTACK + RELEASE + 0.02)
      osc.onended = () => {
        try {
          osc.disconnect()
          gain.disconnect()
        } catch {
          /* already gone */
        }
      }
    })
  } catch {
    // An AudioContext that the browser has suspended, most often because there
    // has been no user gesture yet. Not worth surfacing.
  }
}

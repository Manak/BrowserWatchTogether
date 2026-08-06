/**
 * Turns a stream of microphone levels into a stable "is talking" flag.
 *
 * A raw threshold flickers on every syllable and every keyboard tap, which
 * makes the UI strobe. Asymmetric timing fixes it: react quickly when someone
 * starts (so the indicator does not lag the voice) and slowly when they stop
 * (so pauses between words do not read as silence).
 */

export interface SpeakingOptions {
  /** RMS above this counts as voice. 0..1. */
  threshold: number
  /** Must stay above the threshold this long before we say "speaking". */
  attackMs: number
  /** Must stay below the threshold this long before we say "silent". */
  releaseMs: number
}

export const SPEAKING_DEFAULTS: SpeakingOptions = {
  // Comfortably above room tone and fan noise, below normal speech.
  threshold: 0.045,
  attackMs: 80,
  releaseMs: 500,
}

export class SpeakingDetector {
  private speaking = false
  /** When the level first crossed the threshold in the direction we need. */
  private since: number | null = null

  constructor(private readonly opts: SpeakingOptions = SPEAKING_DEFAULTS) {}

  /** Feed one level reading; returns the debounced speaking state. */
  push(rms: number, now: number): boolean {
    const loud = rms >= this.opts.threshold

    // Level agrees with the current state, so there is nothing pending.
    if (loud === this.speaking) {
      this.since = null
      return this.speaking
    }

    if (this.since === null) this.since = now
    const heldFor = now - this.since
    const needed = loud ? this.opts.attackMs : this.opts.releaseMs

    if (heldFor >= needed) {
      this.speaking = loud
      this.since = null
    }
    return this.speaking
  }

  get isSpeaking(): boolean {
    return this.speaking
  }

  reset(): void {
    this.speaking = false
    this.since = null
  }
}

/** RMS of a time-domain buffer whose samples are centred on 0. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i] as number
    sum += s * s
  }
  return Math.sqrt(sum / samples.length)
}

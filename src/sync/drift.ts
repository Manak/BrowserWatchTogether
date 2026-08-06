import type { Tuning } from './protocol'

export type CorrectionKind = 'none' | 'rate' | 'seek'

export interface Correction {
  kind: CorrectionKind
  /** playbackRate to apply (always meaningful; 1 when kind !== 'rate'). */
  rate: number
  /** Absolute media time to seek to; only set when kind === 'seek'. */
  seekTo?: number
}

export interface DriftInput {
  /** Our video.currentTime. */
  localTime: number
  /** Where the room says we should be. */
  targetTime: number
  /** Whether playback should be advancing at all. */
  advancing: boolean
  /** ms since our last seek — corrections are suppressed while settling. */
  sinceSeekMs: number
  /** Total media duration, when known, so we do not seek past the end. */
  duration?: number
}

/**
 * Decides how to close the gap between us and the room.
 *
 * Three bands, chosen so that the common case is invisible:
 *   |drift| < deadband        → do nothing (chasing noise causes judder)
 *   deadband..hardSeek        → nudge playbackRate, converging smoothly
 *   > hardSeek                → jump, because no tolerable rate closes it
 *
 * Positive drift means we are *ahead* of the room, so we slow down.
 */
export function computeCorrection(input: DriftInput, tuning: Tuning): Correction {
  const { localTime, targetTime, advancing, sinceSeekMs, duration } = input
  const drift = localTime - targetTime

  // While paused there is no rate to modulate — either we are in the right
  // place or we jump there.
  if (!advancing) {
    if (Math.abs(drift) > tuning.pausedDeadbandSec) {
      return { kind: 'seek', rate: 1, seekTo: clampTime(targetTime, duration) }
    }
    return { kind: 'none', rate: 1 }
  }

  if (sinceSeekMs < tuning.settleMs) return { kind: 'none', rate: 1 }

  const magnitude = Math.abs(drift)
  if (magnitude <= tuning.deadbandSec) return { kind: 'none', rate: 1 }

  if (magnitude > tuning.hardSeekSec) {
    return { kind: 'seek', rate: 1, seekTo: clampTime(targetTime, duration) }
  }

  // Erase `drift` over correctionWindowSec, clamped to an imperceptible delta.
  const raw = -drift / tuning.correctionWindowSec
  const delta = clamp(raw, -tuning.maxRateDelta, tuning.maxRateDelta)
  return { kind: 'rate', rate: round3(1 + delta) }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

function clampTime(t: number, duration?: number): number {
  const lo = Math.max(0, t)
  if (duration !== undefined && Number.isFinite(duration) && duration > 0) {
    return Math.min(lo, Math.max(0, duration - 0.05))
  }
  return lo
}

/** Seconds of contiguous buffered media ahead of `time`. */
export function bufferedAhead(
  ranges: { length: number; start(i: number): number; end(i: number): number },
  time: number,
): number {
  for (let i = 0; i < ranges.length; i++) {
    const start = ranges.start(i)
    const end = ranges.end(i)
    // Small tolerance: the playhead often sits a few ms outside a range edge.
    if (time >= start - 0.25 && time <= end) return Math.max(0, end - time)
  }
  return 0
}

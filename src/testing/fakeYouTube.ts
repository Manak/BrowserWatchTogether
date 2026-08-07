import type { YtPlayerLike } from '../youtube/adapter'
import { YT_STATE } from '../youtube/adWatcher'

/**
 * A simulated YouTube embed, advanced by a test-controlled clock.
 *
 * It models the one behaviour that makes YouTube different from a `<video>`:
 * an ad can take over the player at any moment, and while it does, every
 * number the API reports describes the ad instead of the film. Ads are per
 * viewer, so each fake player runs its own.
 */
export class FakeYouTubePlayer implements YtPlayerLike {
  state: number = YT_STATE.CUED
  contentDuration: number
  contentTime = 0
  loadedFraction = 0.5
  rate = 1
  muted = false
  volume = 100

  /** Set while an ad is on. Null the rest of the time. */
  private ad: { duration: number; elapsed: number } | null = null
  /** Content position to return to when the ad finishes. */
  private resumeAt = 0
  /** Refuse to start, the way a phone does before any user gesture. */
  blockAutoplay = false

  seekCalls = 0
  playCalls = 0
  pauseCalls = 0

  constructor(contentDuration = 600) {
    this.contentDuration = contentDuration
  }

  // --- the API surface ---

  playVideo(): void {
    this.playCalls++
    if (this.blockAutoplay) return
    if (this.state !== YT_STATE.ENDED) this.state = YT_STATE.PLAYING
  }

  pauseVideo(): void {
    this.pauseCalls++
    // A real player pauses whatever is on screen — including an ad, which is
    // exactly the trap the adapter exists to avoid walking into.
    this.state = YT_STATE.PAUSED
  }

  seekTo(seconds: number, _allowSeekAhead: boolean): void {
    this.seekCalls++
    if (this.ad) {
      // Seeking during an ad moves the ad, not the film.
      this.ad.elapsed = Math.min(this.ad.duration, Math.max(0, seconds))
      return
    }
    this.contentTime = Math.max(0, Math.min(this.contentDuration, seconds))
  }

  getCurrentTime(): number {
    return this.ad ? this.ad.elapsed : this.contentTime
  }

  getDuration(): number {
    return this.ad ? this.ad.duration : this.contentDuration
  }

  getPlayerState(): number {
    return this.state
  }

  getVideoLoadedFraction(): number {
    return this.loadedFraction
  }

  setPlaybackRate(rate: number): void {
    // YouTube snaps to its own eight speeds; anything else rounds towards 1.
    const allowed = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]
    this.rate = allowed.includes(rate) ? rate : 1
  }

  mute(): void {
    this.muted = true
  }

  unMute(): void {
    this.muted = false
  }

  setVolume(volume: number): void {
    this.volume = volume
  }

  // --- test controls ---

  /** Start an ad break, freezing the film where it stands. */
  startAd(durationSec = 15): void {
    this.resumeAt = this.contentTime
    this.ad = { duration: durationSec, elapsed: 0 }
    this.state = YT_STATE.PLAYING
  }

  /** Hand the player back to the film. */
  endAd(): void {
    this.ad = null
    this.contentTime = this.resumeAt
    this.state = YT_STATE.PLAYING
  }

  get adPlaying(): boolean {
    return this.ad !== null
  }

  /** Simulate `ms` of wall time. */
  advance(ms: number): void {
    const secs = ms / 1000
    if (this.state !== YT_STATE.PLAYING) return
    if (this.ad) {
      this.ad.elapsed += secs
      if (this.ad.elapsed >= this.ad.duration) this.endAd()
      return
    }
    this.contentTime = Math.min(this.contentDuration, this.contentTime + secs * this.rate)
    if (this.contentTime >= this.contentDuration) this.state = YT_STATE.ENDED
  }
}

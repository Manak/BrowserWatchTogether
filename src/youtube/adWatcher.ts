/**
 * Working out whether the YouTube player is showing an ad or the film.
 *
 * This matters because ads are *per viewer*: you get a thirty-second pre-roll,
 * I get none. Two things go wrong if nobody notices.
 *
 * First, the numbers lie. During an ad, `getCurrentTime()` and `getDuration()`
 * describe the ad, not the video — so a peer watching a 15s ad reports its
 * playhead as "3 seconds", and anyone treating that as the film's position
 * drags the whole room back to the beginning.
 *
 * Second, you cannot pause your way out of it. Pausing an ad pauses the *ad*;
 * the film behind it never arrives. So the room has to let each person's ads
 * run and wait for them, which it can only do if it knows an ad is on.
 *
 * The IFrame API has no ad event, so this is inference. The signals, in the
 * order they are trusted:
 *
 *   1. Duration. While the video is merely *cued* — loaded, not started — the
 *      player reports the real duration and no ad can be playing yet (verified
 *      against the live API). That gives an anchor to compare against, and any
 *      later duration that disagrees with it is something other than our video.
 *   2. A duration change mid-playback. If the anchor was missed, a jump from
 *      one duration to another means a boundary was crossed; the duration that
 *      lasts is the film, since ads are the interruption and not the feature.
 *   3. Peers. The film's duration is the same for everyone, so whoever gets
 *      there first can tell the others (see `noteRoomDuration`).
 *
 * Everything here is pure and clock-injected, so the awkward sequences — a
 * pre-roll before the duration is ever known, back-to-back ads, an ad that
 * never ends — are exercised in tests rather than discovered during a film.
 */

/** YouTube player states, from the IFrame API reference. */
export const YT_STATE = {
  UNSTARTED: -1,
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const

export interface PlayerSample {
  /** Wall clock, ms. */
  at: number
  state: number
  /** Whatever the player reports — the ad's timeline during an ad. */
  currentTime: number
  /** 0 while the player has no metadata. */
  duration: number
}

export interface AdView {
  /** The player is showing something other than the video we asked for. */
  adPlaying: boolean
  /** How long the current ad break has been running. 0 when not in one. */
  adElapsedMs: number
  /** The film's duration, or 0 while still unknown. */
  contentDuration: number
  /** Best estimate of the film's playhead, held still while an ad plays. */
  contentTime: number
  /** False until an anchor exists, so callers can stay sceptical. */
  durationKnown: boolean
}

/**
 * Durations wobble: the same video reported 282 while cued and 281.52 a moment
 * into playback. Two seconds absorbs that without swallowing a real ad, which
 * is 5, 6, 15, 20 or 30 seconds and so is never that close to a feature.
 */
const DURATION_TOLERANCE_SEC = 2

export class AdWatcher {
  private contentDuration = 0
  private durationFromCue = false
  private contentTime = 0
  private adPlaying = false
  private adSince = 0
  private lastAt = 0
  /** The last duration we saw, for spotting the moment it changes. */
  private lastDuration = 0
  private lastNonAdDuration = 0

  constructor(startAt = 0) {
    this.contentTime = Math.max(0, startAt)
  }

  /**
   * The film's duration as learned from somebody who is already past their ads.
   * Never overrides an anchor we took ourselves before playback started: ours
   * came from a player that could not have been showing an ad.
   */
  noteRoomDuration(seconds: number): void {
    if (this.durationFromCue) return
    if (!Number.isFinite(seconds) || seconds <= 0) return
    this.contentDuration = seconds
  }

  /** After a seek we know where the film is, whatever the player says. */
  noteSeek(contentTime: number): void {
    this.contentTime = Math.max(0, contentTime)
  }

  observe(s: PlayerSample): AdView {
    this.lastAt = s.at
    const duration = Number.isFinite(s.duration) && s.duration > 0 ? s.duration : 0

    // 1. The cued player is the one moment nothing can be in front of the film.
    if (!this.durationFromCue && duration > 0 && isPreStart(s.state)) {
      this.contentDuration = duration
      this.durationFromCue = true
    }

    // 2. A duration that changes under a running player is a boundary. Whatever
    //    we are on now is the candidate film; an ad will change it back shortly
    //    and rule 3 sorts out which was which.
    if (
      !this.durationFromCue &&
      duration > 0 &&
      this.lastDuration > 0 &&
      Math.abs(duration - this.lastDuration) > DURATION_TOLERANCE_SEC
    ) {
      // Prefer the longer of the two: an ad is not longer than the film it
      // interrupts, and this is only reached when no anchor was ever taken.
      this.contentDuration = Math.max(duration, this.lastDuration)
    }
    if (duration > 0) this.lastDuration = duration

    const known = this.contentDuration > 0
    // Between one thing and the next the player reports no metadata at all —
    // and while it does, *nothing* it says can be used: not the duration, and
    // not the playhead, which reads 0 in that gap.
    const blind = duration === 0

    // 3. With an anchor, the test is simply "is this our video?". Without one,
    //    give the player the benefit of the doubt rather than declaring an ad
    //    that may not exist — a false ad would gate the room for no reason.
    const matches =
      !known || blind
        ? null
        : Math.abs(duration - this.contentDuration) <= DURATION_TOLERANCE_SEC

    // Hold the last verdict across the blind gap. Flapping there would strobe
    // the whole room's gate — everyone stopping and starting twice a second.
    const nowInAd = matches === null ? this.adPlaying : !matches

    if (nowInAd && !this.adPlaying) {
      this.adSince = s.at
    } else if (!nowInAd && this.adPlaying) {
      this.adSince = 0
    }
    this.adPlaying = nowInAd

    if (!nowInAd && !blind) {
      // Only trust the playhead when it belongs to the film. A player that has
      // not started yet reports 0, which would otherwise erase a position we
      // are about to seek to.
      if (!isPreStart(s.state) || s.currentTime > 0) {
        this.contentTime = s.currentTime
      }
      this.lastNonAdDuration = duration
    }

    return this.view()
  }

  view(): AdView {
    return {
      adPlaying: this.adPlaying,
      adElapsedMs: this.adPlaying ? Math.max(0, this.lastAt - this.adSince) : 0,
      contentDuration: this.contentDuration || this.lastNonAdDuration,
      contentTime: this.contentTime,
      durationKnown: this.contentDuration > 0,
    }
  }

  /** Starting a different video throws every assumption away. */
  reset(startAt = 0): void {
    this.contentDuration = 0
    this.durationFromCue = false
    this.contentTime = Math.max(0, startAt)
    this.adPlaying = false
    this.adSince = 0
    this.lastDuration = 0
    this.lastNonAdDuration = 0
  }
}

/** States in which the film has definitely not begun playing. */
function isPreStart(state: number): boolean {
  return state === YT_STATE.CUED || state === YT_STATE.UNSTARTED
}

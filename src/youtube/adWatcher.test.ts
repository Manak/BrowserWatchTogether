import { describe, expect, it } from 'vitest'
import { AdWatcher, YT_STATE } from './adWatcher'

/**
 * The sequences below are written as a player would actually produce them:
 * cue, play, an ad taking the numbers over, the film coming back. What is
 * being asserted throughout is one thing — that the film's playhead is never
 * confused with the ad's, because that is the failure that pulls a room apart.
 */

interface Step {
  state: number
  currentTime: number
  duration: number
}

/**
 * Feed a sequence at 200ms intervals and return the final view. The clock is
 * per-watcher and only ever moves forwards, so a test can play one stretch,
 * assert, and play the next without time going backwards underneath it.
 */
const clocks = new WeakMap<AdWatcher, number>()

function play(watcher: AdWatcher, steps: Step[]) {
  let at = clocks.get(watcher) ?? 0
  let view = watcher.view()
  for (const s of steps) {
    at += 200
    view = watcher.observe({ at, ...s })
  }
  clocks.set(watcher, at)
  return view
}

const cued = (duration: number): Step => ({
  state: YT_STATE.CUED,
  currentTime: 0,
  duration,
})
const playing = (currentTime: number, duration: number): Step => ({
  state: YT_STATE.PLAYING,
  currentTime,
  duration,
})

describe('learning the film’s duration', () => {
  /**
   * The cued player is the one moment nothing can be in front of the film —
   * verified against the live API, which reports the real duration before
   * playback has begun. Everything else here depends on this anchor.
   */
  it('takes the duration from the cued player, before anything can play', () => {
    const w = new AdWatcher()
    const view = play(w, [cued(600)])
    expect(view.contentDuration).toBe(600)
    expect(view.durationKnown).toBe(true)
    expect(view.adPlaying).toBe(false)
  })

  it('absorbs the small wobble between the cued and playing durations', () => {
    // Observed on the real player: 282 while cued, 281.52 a moment into play.
    const w = new AdWatcher()
    const view = play(w, [cued(282), playing(0.5, 281.52), playing(1, 281.52)])
    expect(view.adPlaying).toBe(false)
  })

  it('accepts the duration from a peer that is already past its ads', () => {
    const w = new AdWatcher()
    w.noteRoomDuration(600)
    // A pre-roll, arriving before this player ever reported a duration itself.
    const view = play(w, [playing(1, 15), playing(2, 15)])
    expect(view.adPlaying).toBe(true)
  })

  /** Our own pre-playback anchor is first-hand; a peer's is hearsay. */
  it('does not let a peer overrule an anchor taken before playback', () => {
    const w = new AdWatcher()
    play(w, [cued(600)])
    w.noteRoomDuration(15)
    expect(play(w, [playing(3, 600)]).adPlaying).toBe(false)
  })
})

describe('spotting an ad', () => {
  it('flags a pre-roll and holds the film at the start', () => {
    const w = new AdWatcher()
    const view = play(w, [
      cued(600),
      playing(0.5, 15), // the ad has taken the player over
      playing(1.5, 15),
      playing(2.5, 15),
    ])
    expect(view.adPlaying).toBe(true)
    expect(view.contentTime).toBe(0)
    expect(view.adElapsedMs).toBe(400)
  })

  it('holds the film’s position through a mid-roll and picks it up after', () => {
    const w = new AdWatcher()
    play(w, [cued(600), playing(300, 600), playing(301, 600)])

    const during = play(w, [playing(0.5, 20), playing(5, 20), playing(19, 20)])
    expect(during.adPlaying).toBe(true)
    // The film has not moved: it is not playing.
    expect(during.contentTime).toBe(301)

    const after = play(w, [playing(301.2, 600), playing(302, 600)])
    expect(after.adPlaying).toBe(false)
    expect(after.contentTime).toBe(302)
  })

  it('rides out back-to-back ads as one break', () => {
    const w = new AdWatcher()
    play(w, [cued(600), playing(100, 600)])
    const view = play(w, [
      playing(1, 15), // first ad
      playing(14, 15),
      playing(0.2, 6), // second ad, straight after
      playing(5, 6),
    ])
    expect(view.adPlaying).toBe(true)
    expect(view.contentTime).toBe(100)
    // One continuous break, not two: the timer runs from the first ad sample
    // and is not restarted by the second ad, because the film never came back.
    expect(view.adElapsedMs).toBe(600)
  })

  /**
   * Transitions pass through frames with no metadata at all. Flapping on those
   * would strobe the room's gate — everyone stopping and starting twice a
   * second — so an unknown duration holds whatever was true before it.
   */
  it('does not flap while the player has no duration to report', () => {
    const w = new AdWatcher()
    play(w, [cued(600), playing(100, 600)])
    const view = play(w, [
      { state: YT_STATE.BUFFERING, currentTime: 0, duration: 0 },
      { state: YT_STATE.BUFFERING, currentTime: 0, duration: 0 },
    ])
    expect(view.adPlaying).toBe(false)
    expect(view.contentTime).toBe(100)
  })
})

describe('when the anchor was missed', () => {
  /**
   * If the cued reading never arrived — a slow load, a player adopted late —
   * the first duration change still gives the answer away, because an ad is
   * never longer than the film it interrupts.
   */
  it('recovers the film’s duration from a duration change mid-playback', () => {
    const w = new AdWatcher()
    const view = play(w, [
      playing(1, 15), // pre-roll; nothing yet says this is not the film
      playing(10, 15),
      playing(0.5, 600), // the film arrives
      playing(1.5, 600),
    ])
    expect(view.contentDuration).toBe(600)
    expect(view.adPlaying).toBe(false)
    expect(view.contentTime).toBe(1.5)
  })

  /** With nothing to compare against, do not invent an ad and gate the room. */
  it('assumes the film rather than guessing at an ad', () => {
    const w = new AdWatcher()
    const view = play(w, [playing(1, 15), playing(2, 15)])
    expect(view.adPlaying).toBe(false)
    expect(view.durationKnown).toBe(false)
  })
})

describe('seeks and resets', () => {
  it('trusts a seek over the player while an ad is on', () => {
    const w = new AdWatcher()
    play(w, [cued(600), playing(0.5, 15)])
    w.noteSeek(420)
    expect(w.view().contentTime).toBe(420)
    // The ad's own clock must not overwrite it.
    expect(play(w, [playing(6, 15)]).contentTime).toBe(420)
  })

  it('forgets everything when a different video is loaded', () => {
    const w = new AdWatcher()
    play(w, [cued(600), playing(300, 600)])
    w.reset(0)
    expect(w.view()).toMatchObject({
      adPlaying: false,
      contentTime: 0,
      contentDuration: 0,
      durationKnown: false,
    })
  })

  it('starts at the position from a timestamped link', () => {
    const w = new AdWatcher(90)
    expect(w.view().contentTime).toBe(90)
    // A cued player reports 0; that must not erase where we are headed.
    expect(play(w, [cued(600)]).contentTime).toBe(90)
  })
})

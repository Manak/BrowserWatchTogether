import { describe, expect, it } from 'vitest'
import { FakeYouTubePlayer } from '../testing/fakeYouTube'
import { YouTubeMedia } from './adapter'
import { YT_STATE } from './adWatcher'

/** A clock the test drives, shared by the player and the adapter. */
function setup(contentDuration = 600, startAt = 0) {
  let now = 1000
  const player = new FakeYouTubePlayer(contentDuration)
  const media = new YouTubeMedia(player, { now: () => now, startAt })
  const tick = (ms = 200) => {
    now += ms
    player.advance(ms)
    return media.poll()
  }
  return { player, media, tick, at: () => now }
}

describe('presenting a YouTube embed as a media element', () => {
  it('reports the film’s position and duration', () => {
    const { player, media, tick } = setup(600)
    tick() // cue, which is where the duration comes from
    player.playVideo()
    tick(5000)
    expect(media.duration).toBe(600)
    expect(media.currentTime).toBeCloseTo(5, 1)
    expect(media.paused).toBe(false)
  })

  it('counts a cued player as ready but not as playing', () => {
    const { media, tick } = setup()
    tick()
    expect(media.paused).toBe(true)
    // Ready enough to be the room's timing reference, with nothing being
    // fetched — the same shape a paused <video> that has suspended presents.
    expect(media.readyState).toBeGreaterThanOrEqual(3)
    expect(media.networkState).toBe(1)
  })

  /**
   * Regression, found with two real peers. A player that has its metadata but
   * has never been started reports UNSTARTED, not CUED. Treating that as
   * not-ready deadlocked the room: it waited for that peer, so nothing played,
   * so the player never left the state the room was waiting on.
   */
  it('counts a loaded but never-started player as ready', () => {
    const { player, media, tick } = setup(600)
    tick() // learns the duration from the cued player
    player.state = YT_STATE.UNSTARTED
    tick()
    expect(media.readyState).toBeGreaterThanOrEqual(3)
    expect(media.networkState).toBe(1)
  })

  /**
   * Regression, found with two real peers. Every start passes through
   * BUFFERING, so calling that "not ready" put the two of them in a standoff:
   * each resumed, each blinked through BUFFERING, and each stopped for the
   * other before either got going. The film crawled forward a second at a time
   * while both people were told they were waiting for someone who was fine.
   */
  it('does not call the blink of buffering at every start a stall', () => {
    const { player, media, tick } = setup()
    tick()
    player.playVideo()
    player.state = YT_STATE.BUFFERING
    tick(300)
    expect(media.readyState).toBeGreaterThanOrEqual(3)
  })

  it('does report a sustained wait as a stall, so the room holds', () => {
    const { player, media, tick } = setup()
    tick()
    player.playVideo()
    player.state = YT_STATE.BUFFERING
    tick(200) // the wait starts
    tick(3000) // and is still going
    expect(media.readyState).toBe(2)
  })

  it('forgets a stall once the player gets going again', () => {
    const { player, media, tick } = setup()
    tick()
    player.state = YT_STATE.BUFFERING
    tick(200)
    tick(3000)
    expect(media.readyState).toBe(2)

    player.playVideo()
    tick(200)
    expect(media.readyState).toBe(4)
  })

  it('declares itself unable to trim its playback rate', () => {
    // YouTube rounds anything but its own eight speeds back to 1, so the
    // engine has to be told to seek instead of nudging.
    const { player, media } = setup()
    expect(media.canTrimRate).toBe(false)
    player.setPlaybackRate(1.05)
    expect(player.rate).toBe(1)
  })
})

describe('while an ad is playing', () => {
  it('holds the film’s playhead still instead of reporting the ad’s', () => {
    const { player, media, tick } = setup(600)
    tick()
    player.playVideo()
    tick(10_000)
    const before = media.currentTime

    player.startAd(15)
    tick(4000)

    expect(media.inAd).toBe(true)
    expect(media.currentTime).toBeCloseTo(before, 1)
    // The player itself is four seconds into something.
    expect(player.getCurrentTime()).toBeCloseTo(4, 1)
  })

  it('looks not-ready and unfit to lead, which is what makes the room wait', () => {
    const { player, media, tick } = setup(600)
    tick()
    player.playVideo()
    tick(1000)
    player.startAd(15)
    tick()
    // Below HAVE_CURRENT_DATA: the engine reads this as "cannot keep up" and
    // as "cannot be the room's timing authority".
    expect(media.readyState).toBeLessThan(2)
    expect(media.paused).toBe(true)
  })

  /**
   * The trap this whole layer exists for. Pausing an ad pauses the ad — the
   * film is behind it and never arrives, so a room waiting for this person
   * waits for ever. The ad has to be allowed to finish.
   */
  it('refuses to pause the player', () => {
    const { player, media, tick } = setup(600)
    tick()
    player.playVideo()
    tick(1000)
    player.startAd(10)
    tick()

    media.pause()
    expect(player.pauseCalls).toBe(0)
    expect(player.getPlayerState()).toBe(YT_STATE.PLAYING)

    // And the ad still runs down to its end.
    tick(11_000)
    expect(media.inAd).toBe(false)
  })

  it('defers a seek until the film is back, then applies it', () => {
    const { player, media, tick } = setup(600)
    tick()
    player.playVideo()
    tick(1000)
    player.startAd(10)
    tick()

    media.currentTime = 420
    // Nothing was done to the ad.
    expect(player.seekCalls).toBe(0)
    // But the destination is reported straight away, so the engine does not
    // re-issue the same seek on every update for the length of the ad.
    expect(media.currentTime).toBe(420)

    tick(11_000)
    expect(media.inAd).toBe(false)
    expect(player.seekCalls).toBe(1)
    expect(player.contentTime).toBeCloseTo(420, 1)
  })

  it('lets play() through without a fight', () => {
    const { player, media, tick } = setup(600)
    tick()
    player.playVideo()
    tick(1000)
    player.startAd(10)
    tick()
    // Resolves rather than hanging or throwing: the ad is the only route to
    // the film, and the engine asks again a quarter of a second later.
    return expect(media.play()).resolves.toBeUndefined()
  })
})

describe('autoplay', () => {
  it('resolves play() once the player actually starts', async () => {
    const { media, tick } = setup()
    tick()
    const started = media.play()
    tick()
    await expect(started).resolves.toBeUndefined()
  })

  /**
   * playVideo() returns nothing and a refusal is silent, so the promise the
   * engine relies on for its "tap to start" prompt has to be resolved by
   * watching the player instead.
   */
  it('rejects play() when the player never starts', async () => {
    const { player, media, tick } = setup()
    tick()
    player.blockAutoplay = true
    const started = media.play()
    tick(3000)
    await expect(started).rejects.toThrow()
  })

  it('rejects immediately when the player says outright that it was blocked', async () => {
    const { player, media, tick } = setup()
    tick()
    player.blockAutoplay = true
    const started = media.play()
    media.noteAutoplayBlocked()
    await expect(started).rejects.toThrow()
    // And it stops asking, rather than piling up refusals.
    await expect(media.play()).rejects.toThrow()
  })
})

describe('sound, which stays local', () => {
  it('routes mute and volume to the player', () => {
    const { player, media } = setup()
    media.setMuted(true)
    expect(player.muted).toBe(true)
    media.setVolume(0.5)
    expect(player.volume).toBe(50)
    media.setMuted(false)
    expect(player.muted).toBe(false)
  })

  it('re-applies them to a player that arrives late', () => {
    const player = new FakeYouTubePlayer(600)
    const media = new YouTubeMedia(null, { now: () => 0 })
    media.setMuted(true)
    media.setVolume(0.25)
    media.attachPlayer(player)
    media.applyAudio()
    expect(player.muted).toBe(true)
    expect(player.volume).toBe(25)
  })
})

describe('robustness', () => {
  it('survives a player whose calls all throw', () => {
    const dead = {
      playVideo: () => {
        throw new Error('gone')
      },
      pauseVideo: () => {
        throw new Error('gone')
      },
      seekTo: () => {
        throw new Error('gone')
      },
      getCurrentTime: () => {
        throw new Error('gone')
      },
      getDuration: () => {
        throw new Error('gone')
      },
      getPlayerState: () => {
        throw new Error('gone')
      },
      getVideoLoadedFraction: () => {
        throw new Error('gone')
      },
      setPlaybackRate: () => {},
      mute: () => {},
      unMute: () => {},
      setVolume: () => {},
    }
    const media = new YouTubeMedia(dead, { now: () => 0 })
    expect(() => media.poll()).not.toThrow()
    expect(() => media.pause()).not.toThrow()
    expect(() => (media.currentTime = 10)).not.toThrow()
    expect(media.currentTime).toBe(10)
  })

  it('starts at the position from a timestamped link', () => {
    const { media, tick } = setup(600, 90)
    tick()
    expect(media.currentTime).toBe(90)
  })

  it('forgets what it learned when a different video is loaded', () => {
    const { player, media, tick } = setup(600)
    tick()
    player.playVideo()
    tick(5000)
    media.resetFor(0)
    expect(media.currentTime).toBe(0)
    expect(media.duration).toBe(0)
  })
})

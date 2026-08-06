import type { LevelMeter } from './voiceChat'
import { rmsOf } from './speaking'

/**
 * The thin layer of real browser APIs the voice chat needs. Kept apart from
 * VoiceChat so the logic stays testable and the platform quirks stay in one
 * readable place.
 */

/**
 * Tell the platform we intend to play *and* capture at the same time.
 *
 * This is the anti-ducking measure that actually has teeth. On iOS, opening a
 * microphone flips the audio session to a voice-call mode: other audio is
 * attenuated and output can move to the earpiece. Declaring "play-and-record"
 * up front tells Safari we want both, so the film keeps its volume and its
 * routing. Safari-only today; a no-op everywhere else, which is fine because
 * no other platform does the ducking in the first place.
 */
export function configureAudioSession(): void {
  const session = (
    globalThis.navigator as Navigator & { audioSession?: { type: string } }
  )?.audioSession
  if (!session) return
  try {
    session.type = 'play-and-record'
  } catch {
    /* older Safari exposes the object but not this value */
  }
}

let sharedContext: AudioContext | null = null

function audioContext(): AudioContext | null {
  const Ctor =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  if (!sharedContext || sharedContext.state === 'closed') {
    // 'interactive' asks for the smallest buffer the device will give us.
    sharedContext = new Ctor({ latencyHint: 'interactive' })
  }
  if (sharedContext.state === 'suspended') void sharedContext.resume()
  return sharedContext
}

/**
 * Level meter over the local microphone.
 *
 * Note this only ever taps the *outgoing* stream — it is never connected to
 * the context destination, so it makes no sound and cannot affect playback.
 */
export function makeMeter(stream: MediaStream): LevelMeter | null {
  const ctx = audioContext()
  if (!ctx) return null
  try {
    const source = ctx.createMediaStreamSource(stream)
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.2
    source.connect(analyser) // deliberately not connected onward to output
    const buf = new Float32Array(analyser.fftSize)
    return {
      rms() {
        analyser.getFloatTimeDomainData(buf)
        return rmsOf(buf)
      },
      close() {
        try {
          source.disconnect()
          analyser.disconnect()
        } catch {
          /* already torn down */
        }
      },
    }
  } catch {
    return null
  }
}

/**
 * Play a peer's microphone through a dedicated <audio> element.
 *
 * A separate element per peer, rather than mixing through WebAudio: it keeps
 * the browser's own echo canceller in the loop (it needs to know what is being
 * rendered), and it leaves the video element completely alone.
 */
export function playRemote(stream: MediaStream, peerId: string): () => void {
  if (typeof document === 'undefined') return () => {}
  const el = document.createElement('audio')
  el.srcObject = stream
  el.autoplay = true
  // Full volume, always. Voice is never ducked against the film, nor the film
  // against voice — the two simply mix.
  el.volume = 1
  el.muted = false
  el.setAttribute('playsinline', '')
  el.dataset.peer = peerId
  el.style.display = 'none'
  document.body.appendChild(el)
  void el.play().catch(() => {
    // Autoplay refused until a gesture. Enabling the mic is itself a gesture,
    // so this resolves as soon as the user opts in.
  })
  return () => {
    try {
      el.pause()
      el.srcObject = null
      el.remove()
    } catch {
      /* already gone */
    }
  }
}

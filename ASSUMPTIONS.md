# Assumptions and open questions

Written while you were away, so nothing here has been agreed with you. Each item
says what I decided, why, and what it would take to change. The ones marked
**⚠️** are the ones I would most want a second opinion on.

---

## Architecture

### 1. No backend at all — Trystero over public Nostr relays ⚠️

You preferred "no server, and if possible no compute". I took that literally.
[Trystero](https://github.com/dmotz/trystero) gets peers connected using public
Nostr relays for signalling only; after that, everything is direct
browser-to-browser WebRTC. The whole app is static files.

**The trade-off:** the relays are free public infrastructure run by strangers.
They are used for a few hundred bytes at join time and nothing after, but if
they were all down at once, new peers could not find each other (existing
connections would keep working). There is no SLA.

**If you would rather not depend on them,** the alternatives, in increasing
order of effort: switch the strategy to MQTT or BitTorrent trackers (a one-line
import change — Trystero ships all of them); point it at your own Nostr relay;
or move signalling to a Netlify function with a small KV store. `netlify.toml`
is already in the repo for that path.

### 1b. Signalling relays are pinned to a curated list

Trystero's default is to sample from dozens of community Nostr relays, and
several are frequently down. A dead relay retries forever — console noise on a
laptop, wasted battery and mobile data on a phone. So the app pins six
long-running relays (all verified reachable) and connects to four at a time.

Only one needs to work: peers match through whichever relays they have in
common, and once WebRTC connects the relays are not used again for that pair.
The list is at the top of `src/sync/trysteroTransport.ts`.

### 2. No TURN server, so a few networks will fail ⚠️

STUN (free, Google/Cloudflare) handles most home networks. Symmetric NATs and
strict corporate firewalls need a TURN relay, which must be paid for and always
on — that would break the "no compute" goal. I chose the goal over the edge
case.

If you and your girlfriend ever cannot connect, this is the most likely reason,
and it is fixable by adding a TURN provider's credentials to `rtcConfig` in
`src/sync/trysteroTransport.ts`.

### 3. Mesh topology, sized for a couple

Every peer connects to every other peer. Perfect for 2, fine up to about 6, bad
at 20. Given the stated use case I did not build a star topology or relay.

### 4. React StrictMode is off

Its development-only double-mount would join and leave the relays twice with the
same peer id, confusing the other side of a real room. Noted in `src/main.tsx`.

---

## Google Drive

### 5. Playback uses the public download endpoint, not the Drive API

You asked to avoid the API, so:
`https://drive.usercontent.google.com/download?id=<ID>&export=download&confirm=t`

`confirm=t` skips the "can't scan this file for viruses" interstitial that every
video-sized file otherwise returns. This endpoint supports HTTP range requests,
which is what makes seeking work.

**Consequences you should know about:**

- **Google rate-limits popular files.** If a file is downloaded a lot, Drive
  starts returning "Sorry, you can't view or download this file at this time"
  for up to 24 hours. Nothing client-side can avoid this. For two people
  watching one film it is unlikely; it is a real risk if you share a room widely.
- **Only browser-playable formats work.** MP4/H.264/AAC plays everywhere.
  MKV, AVI, and most HEVC files will not play, because the browser decodes them,
  not Drive. The error message says this.
- **No CORS headers**, so the app deliberately does not set `crossorigin` on the
  video element. Everything still plays; we just cannot read pixels or get
  detailed error bodies.

### 6. "Is it public?" is a thumbnail probe, and it is advisory ⚠️

You asked for an error when a link is not public. Without the API there is no
clean way to ask. So the app loads `drive.google.com/thumbnail?id=…` in an
`<img>`: public files return an image to anonymous requests, restricted ones do
not. It needs no CORS and costs one small request.

**It can be wrong.** A genuinely public file that Drive has not thumbnailed yet
(unusual codec, very recent upload) will fail the probe. So the app shows the
error and the fix-it instructions as you asked, but also offers a **"Try it
anyway"** button rather than dead-ending someone with a valid file. The `<video>`
element is the final authority, and its failure message also points at sharing
settings.

Tell me if you would rather it be a hard block with no override.

### 7. put.io and plain direct links are supported alongside Drive

Any `https://…` URL that points at a media file is accepted. Drive links get the
full treatment (id parsing, sharing check, Drive-specific errors); direct links
skip the sharing check because it does not apply.

put.io is handled specifically, because its obvious link does not work:
`/files/<id>/download/…` serves the original, usually MKV/HEVC, which serves as
`video/x-matroska` and plays in no browser. `/files/<id>/mp4/download/…` serves
put.io's H.264 + AAC conversion, which plays everywhere. A pasted raw link is
rewritten to the converted one automatically, query string preserved.

**One thing to watch:** put.io download URLs embed an account-wide
`oauth_token`, and the media URL is broadcast to every peer in the room. The
app shows a warning when a link carries a credential, but the safe habit is to
treat a room containing such a link as if you had pasted the token into a group
chat. Related code is in `src/lib/media.ts`.

---

## YouTube

### 7a. YouTube plays in YouTube's embed, and there was no choice about it

A YouTube video cannot go into a `<video>` element — the bytes are not fetchable
and the terms of service are unambiguous. The only sanctioned way to play one on
another page is the iframe embed driven by the IFrame Player API, so that is what
this uses. It is the app's only third-party script, loaded lazily: a room
watching a Drive file never touches youtube.com.

The embed is wrapped in an adapter (`src/youtube/adapter.ts`) that presents the
same shape as a `<video>`, so the sync engine drives both through one interface
and none of the sync logic has a YouTube branch in it.

The embed uses `youtube-nocookie.com`, which is the same player without the
tracking cookies until something is actually played.

### 7b. Ad detection is inference, and it is the part most likely to need tuning ⚠️

**This is the assumption I would look at first.** The IFrame API has no ad event
and exposes no ad state. During an ad, `getCurrentTime()` and `getDuration()`
describe the ad rather than the film — which is not a cosmetic problem, because
a peer reporting the ad's playhead as the film's would drag everyone back to the
start.

So it is worked out from the numbers, and the anchor is this: while a video is
*cued* — loaded but not started — the player reports the film's real duration and
no ad can be in front of it yet. I verified that against the live API before
building on it (a cued player reported 635s and 282s for two different videos,
before any playback). Anything that later disagrees with that anchor is not our
film. Two fallbacks back it up: a duration change mid-playback also marks a
boundary, and peers share the film's duration with each other so a peer stuck
behind a pre-roll can still tell what it is looking at.

What I could **not** verify is an actual ad, because YouTube did not serve one in
any of the test playbacks — ads in embeds are non-deterministic, and this is not
something a test can force. The logic is covered by unit tests that replay the
sequences a player produces (pre-roll, mid-roll, back-to-back ads, an ad while
the duration is still unknown), but replaying a modelled sequence is not the same
as meeting the real thing. If ads ever appear to be missed or imagined, the
tolerance and the anchor rules in `src/youtube/adWatcher.ts` are where to look.

Because it is inference, two safety valves exist:

- **The wait is capped at 90 seconds.** An ad state that never clears would
  otherwise stop the film for everybody with no way back but the panel switch.
- **Ads never make anyone the room's timing authority.** A peer showing an ad has
  a frozen playhead, so it is excluded from leadership until its film returns.

### 7c. The room waits for each person's ads rather than letting them fall behind

Ads are per viewer, so the alternatives were: let people drift apart by the
length of their ads, or stop for each of them. Stopping is what "watch together"
means, and it is the same thing the room already does for someone whose
connection stalls. "Wait for everyone" turns it off for people who would rather
not.

One trap worth recording: **the room must not pause a player during an ad.**
Pausing an ad pauses the ad — the film is behind it and never arrives — so a room
waiting for that person would wait for ever. Play, pause and seek are dropped or
deferred for the length of the ad instead.

### 7d. Clicking the picture drives the room, and YouTube's own controls are off

The embed is loaded with `controls: 0` and a transparent catcher over the frame.
Two people watching one film need one set of controls: a scrub inside YouTube's
player moves that person alone and desyncs the room silently, with nothing on
screen to explain it.

The catcher does not swallow the click — it sends it to the engine, so clicking
the picture plays and pauses for everybody, which is what people expect a click
on a video to do. It is removed from the page while an ad is playing, so the Skip
button stays reachable by the person whose ad it is. Since the catcher covers
YouTube's own "Watch on YouTube" affordance, an *Open on YouTube* link sits under
the title instead.

### 7f. On an iPhone the embed keeps its own controls, because fullscreen needs them

iPhone Safari has no Fullscreen API for anything but a `<video>` —
`requestFullscreen` and `webkitRequestFullscreen` are both undefined on the
document element, verified on the device. A Drive file copes: there is a real
`<video>` to hand to `webkitEnterFullscreen`. A YouTube embed has none — its
`<video>` is inside a cross-origin iframe — so our fullscreen button had nothing
to call and did nothing at all.

YouTube's own fullscreen button does work there, and it exists only as part of
its control bar, so on a browser that cannot fullscreen an element the bar is
turned back on and our button is hidden. Which browser that is comes from a
feature test rather than a user-agent list, so a Safari that gains the API
starts using our button again on its own.

The cost is that YouTube's controls are then reachable, and a scrub or a pause
there would otherwise move one person. So the room adopts them, the same bargain
it already strikes with Apple's native player for a Drive file. Play and pause
come from the state change; a seek has no event at all, so it is inferred from a
playhead move that playback cannot account for — ignoring ads, which rewrite the
playhead by themselves, and our own seeks.

Adoption deliberately does not start until the player has played something. A
freshly loaded player sits in CUED, which reads as paused, and a peer joining a
room already in progress would otherwise announce that as a pause and stop the
film for everybody.

Everywhere else this changes nothing: controls stay off, the click catcher stays,
and our own fullscreen button is the one that works.

### 7e. Drift is corrected by seeking, not by trimming the rate

A YouTube embed accepts eight fixed playback speeds and rounds anything else back
to 1× — verified: `setPlaybackRate(1.05)` reads back as `1`. The engine's usual
correction, running a few percent fast or slow where nobody can hear it, does
nothing at all here.

So for a player that reports it cannot trim its rate, the engine drops the
threshold at which it gives up and seeks (0.7s rather than 2s). The result is an
occasional small jump instead of two seconds of silent drift. A jump is more
noticeable than a rate nudge; two seconds out of sync is more noticeable still.

---

## Sync behaviour

### 8. Aiming far tighter than 3–5 seconds

You said 3–5s was acceptable. The design targets well under one second, because
the corrections that keep you within 1s are the same ones that keep you within
5s, and being tighter costs nothing:

| Drift | Response |
| --- | --- |
| under 0.15s | ignored — chasing noise is what causes visible judder |
| 0.15s – 2s | playback rate nudged up to ±10%, converging over ~12s |
| over 2s | hard seek |

Two real browsers measured **15ms apart** during manual testing. Your 3–5s
budget is the guard rail, not the target. All the numbers are in one place
(`TUNING` in `src/sync/protocol.ts`) if you want it looser and lazier.

### 9. Rate correction is capped at ±10% so it never stutters

A 10% speed change is inaudible on speech and invisible on video, and unlike
seeking it never re-buffers. Seeking is reserved for gaps too large to close
smoothly.

### 10. The "host" is not the room creator

The timing reference is whichever connected peer has the lowest id *and* has the
video loaded. This is computed independently by every peer from information they
all have, so leadership transfers instantly when someone leaves, with no election
messages. It is labelled "host" in the participant list.

The "has the video loaded" part exists because I hit the bug without it: a
newcomer with a low id became host the instant it joined, and heartbeated a
playhead of zero.

### 11. "Wait for everyone" defaults to on

When anyone's buffer runs dry, the room pauses and shows who it is waiting for,
then everyone resumes together. There is a checkbox to turn it off, which is
what you want if one person has bad Wi-Fi and would rather the others carried on.
It is a room-wide setting, not per-person.

### 12. Simultaneous conflicting presses resolve by peer id

If you hit play at the same instant your girlfriend hits pause, both browsers
independently pick the same winner (lower peer id) rather than flapping. It is
arbitrary but consistent, which is the property that matters.

### 13. Volume, mute, and fullscreen are personal, not synced

Deliberate: nobody wants their partner's volume changes applied to their own
headphones.

---

## Voice chat

### 13b. The video is never ducked, structurally

You asked for no ducking. Rather than "we promise not to", the voice layer is
built with no reference to the video element at all — there is no code path
from a microphone to `video.volume`, so it cannot duck the film even by
mistake. A test asserts the surface stays that way. Voice and film simply mix.

Echo is handled the other way round: the browser's echo canceller removes the
film from your *outgoing* microphone, so your partner does not hear a doubled
soundtrack. Your own playback is untouched.

### 13c-bis. Getting remote voice to play on iOS at all

The first version was inaudible on iOS, for three separate reasons, all fixed:

- The sink element was hidden with `display: none`. iOS will not play media in
  an element it is not displaying, so it is now sized to a transparent pixel
  instead.
- It was an `<audio>` element. WebKit has never played a remote MediaStream
  reliably through one; it is now a `<video playsinline>` carrying only an
  audio track, which does work.
- Worst of all, the `play()` rejection was swallowed. A listener who joins to
  watch and never touches the screen has made **no user gesture**, so iOS
  blocks their partner's voice — and nothing retried. Blocked playback is now
  tracked and retried on the first interaction anywhere in the page, with a
  visible "tap to hear" prompt as the fallback for someone who touches nothing.

The lesson generalises: the person who needs the gesture is the *listener*, not
the person turning their microphone on.

### 13c. iOS is the one platform that can still quieten things ⚠️

Opening a microphone on iOS switches the system audio session to a voice-call
mode, which attenuates other audio and can move output to the earpiece. That is
an OS decision, not ours. The app declares
`navigator.audioSession.type = 'play-and-record'` before capturing, which is the
supported way to ask Safari to keep both running properly, and is a no-op
elsewhere.

I could not test this on a real iPhone. If you find the film gets quiet when
voice is on, that is where to look — and headphones sidestep it entirely.

### 13d. Low latency comes from the connection, not from tuning

Audio rides the peer connections that already exist, so there is no server hop.
Beyond that the only lever worth pulling is the receiver jitter buffer:
Chromium's `playoutDelayHint` is set to 0, asking for the smallest buffer it
will give us. It is non-standard and simply absent in Safari and Firefox, where
the default buffer applies.

### 13f. Voice is on by default and asks on join ⚠️

You asked for the permission to be requested on joining, unmuted. So the room
requests the microphone as part of connecting, rather than hiding it behind a
button someone has to find once the film is running.

The judgement I made on top of that: the preference is **remembered**, so
turning voice off sticks and you are not asked again on the next room. The
default for a first-time visitor is on. If you would rather it defaulted to off
until asked for, that is one line in `voiceWantedOnJoin`.

Note that some browsers require a user gesture before granting a microphone. If
one refuses, nothing breaks — the panel falls back to a "Turn on" button. So
this can only save a step, never cost one.

### 13e. Speaking is detected locally and announced

Each peer analyses only its own microphone and broadcasts a boolean, rather than
every peer running an analyser over every incoming stream. One small message
beats N audio graphs, and it keeps working where a browser will not hand us an
analyser at all. Detection is deliberately asymmetric — quick to light up,
slow to go dark — so the indicator does not strobe between syllables.

---

## Recovering from a bad connection

### 13g. Reconnects are treated as joins

`addStream` only reaches the peers connected at the moment it is called, so a
peer that joins — or rejoins after their connection dropped — would hear
silence from us forever. The microphone is now re-offered to each arriving
peer, and since a reconnect looks exactly like a join, that is the recovery
path as well as the join path.

The sync engine already tolerated this: peers re-exchange names and state on
reconnect, and whoever holds the highest control epoch supplies it.

### 13h. A network error reloads the video rather than giving up

A dropped connection is not a broken file, but the video element reports both
the same way. `MEDIA_ERR_NETWORK` now retries the source with backoff (1s
through 30s, six attempts), restoring the playhead each time, before showing an
error. Any other error code still fails immediately — a file that is not shared
publicly will not fix itself by being asked again.

### 13k. Catch-up sends the live position, not the last button press

Reported: the host refreshed an hour into a film and the room jumped back to
the start.

`playback` is anchored to whenever someone last pressed something, which can be
hours ago. A newcomer has no round-trip sample for the sender yet, so it cannot
convert that timestamp and deliberately treats it as "now" (see the clock notes
in docs/SYNC.md) — which silently discards every minute of elapsed playback.
The rejoining host therefore landed at zero, and being the lowest peer id, took
over as host and dragged everyone else back with it.

Catch-up now sends the sender's *actual current playhead* stamped now, so the
worst case is one network hop of error instead of the whole film.

### 13l. A failed first join used to be permanent

Reported from real use: two people on different networks open the same room,
both see *Couldn't reach anyone*, and it never clears. Reloading fixed it —
which is the tell. The connection was retryable and nothing retried.

Two things were wrong, and the first is the interesting one.

**Nothing retried a room that had never worked.** The reconnect watchdog only
rebuilds a room that has *had* peers and lost them (13j), on the reasoning that
somebody sitting alone is not broken. But Trystero reports a join error only
after it has *found* a peer and failed to connect to it — which is the opposite
of an empty room. That case now arms the watchdog, and it rebuilds with the same
backoff as everything else. Someone genuinely alone is still left alone.

**Ten seconds was not always enough.** Trystero gives a peer that long, from its
data channel opening, to finish the room-password challenge; losing that race
writes the peer off. It is a comfortable margin between two tabs on one machine
and a tight one between a laptop and a phone on mobile data. It is now thirty.
Waiting longer costs nothing; timing out costs the room.

The status chip says *Can't reach them · retrying* rather than *Couldn't reach
anyone*, because that is now what is happening.

**What this was not:** signalling. Two peers announcing on a real room topic,
with the app's own `appId` and relay list, reached each other through five of
the six relays when this was measured. Room-code normalisation, topic derivation
and the password key derivation are deterministic and identical on both sides.
If a join still fails after this, the next suspect is the one thing the app
deliberately does not have — a TURN relay (see 2).

### 13j. Locking a phone used to end the room silently ⚠️

Reported from real use: lock the phone, and the desktop sees you leave; unlock,
and the phone still believes it is in the room while the desktop cannot see it.
Neither side ever retried.

Two things were wrong. iOS suspends the page and tears down the WebRTC
connections while it sleeps, and nothing detected that on waking. And when a
rebuild was attempted, **Trystero returns the existing room object if you join
an id it still has registered** — it only deregisters inside `leave()`, which
we were firing without awaiting. So the "reconnect" handed back the very dead
connection it was replacing.

Now: a watchdog rebuilds the connection when a room that *has* worked loses
every peer, with backoff so an empty room does not thrash, and faster after a
wake because that is the common case. The rebuild waits for the previous
`leave()` to finish deregistering. Verified end to end — a peer lost and
rediscovered on a rebuilt transport.

The conservative part is deliberate: a room that has never had anyone in it is
not considered broken, so sitting alone waiting for someone will not tear down
the video you just queued.

### 13i. Native controls are adopted, not fought

iPhone has no Fullscreen API for anything but a `<video>`, so there fullscreen
hands the screen to Apple's player and our controls are not available.

I did try expanding our own player to fill the viewport instead, to keep our
UI — it looked wrong in practice and was reverted. Worth knowing if it comes up
again: the honest options are Apple's player (what we do now) or a pseudo-
fullscreen that cannot hide Safari's own chrome and so never quite looks right.

What makes the native player acceptable is that the engine adopts play, pause
and seek made outside our controls, so the room stays in sync through it. It
ignores anything landing within a beat of a change it made itself, and the same
mechanism covers lock-screen buttons, headsets and picture-in-picture.

Controls auto-hide after three seconds of stillness while playing. The hiding
is timed in JS because `:hover` is always true once the player covers the
screen and so can never express "idle" — but the fullscreen *layout* is keyed
on the `:fullscreen` selector, not a class, so it cannot be left unstyled by a
stale piece of React state.

---

## Product decisions

### 14. Rooms hold no state of their own

There is no database, so a room exists only while someone is in it. If you both
close the tab, the video choice is gone and you re-paste the link. Your name is
remembered in `localStorage`; nothing else is stored anywhere.

### 15. The room code is the only secret

Anyone with the code can join, and the code doubles as the encryption password
for signalling. There are no accounts, passwords, or kick/ban controls. Codes
are `word-word-number` — readable over the phone, and with no directory of live
rooms to enumerate, guessing one is impractical.

### 16. Changing the video restarts it at zero for everyone

You said changing content requires a new link, which the app enforces. I also
made it reset the playhead and pause, since a timestamp from the previous file
is meaningless in the new one.

### 17. No chat, no voice, no reactions

Not requested, and you will presumably be on the phone with each other. Easy to
add — the transport carries arbitrary messages already.

---

## Things I could not verify

- **Real Google Drive playback.** I have no public Drive video to test with, so
  the Drive URL construction and the sharing probe are covered by unit tests and
  by how these endpoints are known to behave — not by an end-to-end run. **This
  is the first thing to try when you are back.** Sync itself was verified
  end-to-end with two real browsers over real WebRTC.
- **Real iOS and Android browsers.** The layout was tested at phone dimensions
  and the mobile-specific hazards are handled explicitly (`playsinline`, the
  tap-to-start gate for autoplay policy, 16px inputs so iOS does not zoom,
  44px tap targets, safe-area insets, the iOS-only fullscreen fallback). But
  that is not the same as having held a phone.
- **Two people on different networks.** Everything so far was browser tabs on
  one machine. NAT traversal is the untested part.
- **A real YouTube ad.** YouTube served none during testing, and ads in embeds
  cannot be forced. Everything the ad handling rests on *was* checked against the
  live player — the cued-duration anchor, the playback-rate rounding, the state
  sequence at startup — but the ad path itself has only been exercised against
  modelled sequences. See 7b.
- **The YouTube fullscreen transition on an iPhone.** The embed keeps its own
  controls there and its fullscreen button is the one that works (see 7f). I
  confirmed on an iPhone that the feature test reads false and that the button
  is drawn, but not that tapping it fills the screen: YouTube will not play in
  the simulator, which has no decoder for it.

What *was* verified end-to-end with two real browsers on a real WebRTC
connection: a YouTube video cueing on both peers with the same duration, play,
pause and seek propagating between them, the two playheads staying within about
a second, the room's controls driving the embed, click-to-pause going through
the room, the title arriving from oEmbed, a `?t=` start time being honoured, and
the "owner does not allow embedding" refusal showing its explanation.

One thing worth knowing: during testing a third peer once failed its initial
WebRTC handshake and recovered on reload. Peer connection is inherently
best-effort, so the app now treats a join error as per-peer rather than fatal —
the status only reports trouble when you are genuinely talking to nobody, and it
clears itself the moment anyone connects.

---

## Suggested first test when you are back

1. Put a short MP4 in Drive, share it as *Anyone with the link*.
2. Open the app on your laptop, start a room, paste the link.
3. Open the room URL on your phone **over mobile data, not Wi-Fi** — that
   exercises NAT traversal properly.
4. Play, seek, and pause from both ends; watch the drift readout under the title.
5. Put the phone in a lift or turn Wi-Fi off briefly to see the buffering gate.
6. Then do it again with a YouTube link, and pick something monetised enough to
   actually serve an ad — a music video is the reliable choice. What to watch
   for: the other screen stops and says *"… has an ad"* rather than *Buffering*,
   the Skip button is clickable on the screen showing the ad, and both playheads
   line up again when it ends. That is the one behaviour I could not make
   YouTube demonstrate on demand (see 7b).

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

### 13e. Speaking is detected locally and announced

Each peer analyses only its own microphone and broadcasts a boolean, rather than
every peer running an analyser over every incoming stream. One small message
beats N audio graphs, and it keeps working where a browser will not hand us an
analyser at all. Detection is deliberately asymmetric — quick to light up,
slow to go dark — so the indicator does not strobe between syllables.

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

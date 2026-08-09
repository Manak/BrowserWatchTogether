# Watch Together

Watch a video in sync with someone else, on a phone or a laptop. No server, no
database, no accounts. Takes YouTube links, public Google Drive links, put.io
links, any direct video URL — or a file straight off your own computer, with
nothing uploaded anywhere.

Two people open the same room code, one pastes a link, and both players stay
locked to the same frame. Play, pause, and seek propagate to everyone; if one
person's connection stalls, the room waits for them and starts again together.
YouTube ads are handled the same way: they are served to each person separately,
so the room stops for whoever is watching one and starts again together when it
ends. There is voice chat too, so you can talk over the film — it asks for your
microphone as you join, and starts unmuted.

---

## How it works

```
              ┌──── one Nostr relay ────┐   (offers only, once, encrypted)
              ▼                         ▼
  Browser A  ──────── WebRTC data channel ────────  Browser B
      │            (encrypted, direct, P2P)             │
      │                                                 │
      └── <video src="drive.usercontent.google.com/…">  ┘
                 (each browser downloads independently)
```

Nothing but an introduction passes through a server. Everything after the
introduction is direct.

**Finding each other.** [Trystero](https://github.com/dmotz/trystero) handles
the WebRTC handshake; the offers travel through one public Nostr relay, chosen
by the room's own code. Once the browsers are connected it is not used again,
and while it is, it only ever sees encrypted blobs: the topics are hashes of the
room code and the payloads are encrypted with it. See
[Finding each other](#finding-each-other).

**Playing the video.** Each browser downloads the file straight into a plain
`<video>` element — from Google Drive's public download endpoint, from put.io,
or from any direct URL. No Drive API, no API key, no OAuth. These endpoints
support HTTP range requests, which is what makes seeking work.

**Playing YouTube.** YouTube cannot go in a `<video>` element, so it plays in
YouTube's own embed, driven by the IFrame Player API. The room does not know the
difference: the embed is wrapped in an adapter that presents the same shape as a
`<video>` element, and the sync engine drives both through that one interface.
See [Ads](#ads) for the part that is genuinely different.

put.io serves both the original file and an H.264 conversion at the same id.
The original is usually MKV/HEVC, which no browser plays, so a pasted
`/files/<id>/download/…` link is switched to `/files/<id>/mp4/download/…`
automatically.

**Talking over it.** Voice chat rides the same peer connections, so there is no
second connection and no server in the audio path. The microphone is captured
with echo cancellation, which removes the film from your *outgoing* audio — the
other person stops hearing a doubled soundtrack. Nothing ever turns the video
down: the voice layer has no reference to the video element, so it cannot duck
it even by accident, and the two streams simply mix.

**Staying in sync** is the interesting part — see
[docs/SYNC.md](docs/SYNC.md) for the algorithm.

---

## Playing a file off your own computer

Pick an MP4 in the Video panel and everyone in the room watches it. It is not
uploaded: the browser holding the file answers the others' requests for byte
ranges over the connections that already exist, and each of them plays it as it
arrives.

```
  Desktop (has film.mp4)                    Phone
   │                                          │
   │  ◄── "bytes 41,943,040-42,467,327" ──────┤  <video src=".../__wt-share/x">
   │  ─── 512 KB ─────────────────────────►   │         ▲
   │        (WebRTC data channel)             │         │ 206 Partial Content
   └──────────────────────────────────────────┘   service worker
```

The trick is the service worker. A `<video>` cannot be pointed at a file on
somebody else's laptop, so the worker invents a URL for it and answers the
element's ordinary HTTP range requests by asking the peer. As far as the video
element is concerned this is a normal video on a normal server, which is what
makes the useful things fall out for free:

- **Playback starts on the first chunk**, not after the whole file.
- **Seeking is a range request.** Jumping an hour in fetches the bytes at that
  point and nothing before them.
- **Joining mid-film costs nothing.** A late arrival fetches the bytes under the
  room's playhead. Nobody re-watches the first hour to get to the second.
- **Memory stays flat.** A reply is capped at 512 KB however much is asked for,
  so a 4 GB film never exists anywhere but on the disk it started on.

Sharing is deliberately **desktop only**; watching a shared file works
everywhere, including iPhones, which is the point. Serving one means uploading
the film to each viewer for as long as it runs, from a tab that has to stay
awake — a phone fails all of that, and its video library is mostly HEVC `.mov`
that no other device can decode.

Some browsers will not let a service worker answer a media element. There the
room falls back to copying the whole file across first and playing it from
memory; it says so, with a progress bar, and **the rest of the room carries on**
rather than waiting — that person joins at whatever point the film has reached,
exactly like anyone arriving late.

Two things to know. The film lasts as long as the tab: close it, or reload it,
and the share is gone and someone has to pick the file again. And nothing is
stored — no copy is written to disk on the receiving side, and a downloaded copy
is discarded when you leave the room.

---

## Finding each other

Two browsers cannot find each other unaided: somebody has to carry the first
WebRTC offer until the other side collects it. That is the entire job, it takes
a few kilobytes, and once it is done that server is never used again for those
two people.

**One relay per room, picked by the room's name.** `src/sync/nostrRelays.ts`
hashes the room code and indexes into a pinned pool of six long-running public
Nostr relays. Both browsers hash the same string and land on the same host,
which is the only property that matters — peers on different relays never find
each other, peers on the same one always do.

Handing every room all six, which is what this used to do, sounds like
redundancy and mostly is not: both browsers then opened six sockets, announced
on six topics and ran six independent offer exchanges to build one connection,
with six chances for the same pair to race each other into a discarded offer.
One relay each also spreads rooms over the pool instead of stacking them onto
whichever host is first in a list.

The cost is real and worth stating: a room is only as reachable as the one relay
its name chose. `RELAYS_PER_ROOM` is the dial — at 2 a room keeps a
deterministic assignment and gets a spare, at the price of bringing the racing
back.

**What the relay can see.** Nothing useful. Trystero derives the topics by
hashing the room code and encrypts every payload with it before publishing, so
the relay carries opaque strings under opaque names. It never sees the room
code, the video, or who is watching. Nostr relay operators have no idea they are
carrying WebRTC signalling, and could not join a room if they did.

**What travels over it, and what does not.** Over the relay: the announce, the
offer, the answer, the ICE candidates. Over the direct connection, from then on:
the room password handshake, every play/pause/seek, heartbeats, clock sync,
names, voice audio, and the bytes of a shared film. The socket does stay open
for the life of the room, re-announcing every few seconds so a *later* joiner
can still be found — but that is all it carries.

**We ran our own for a while,** and it is still in the tree:
`netlify/functions/signal.ts` with the logic in `src/signal/relay.ts` and the
client in `src/sync/relayStrategy.ts`, whole and tested. The reason for it was
good — a public relay answers to nobody, so a room that will not connect leaves
nothing to inspect. The reason it is not the default is better: Netlify cannot
hold a WebSocket open, so the client had to poll, and every step of the
handshake then waited out a poll interval. Three to six seconds before two
browsers in the same room could see each other, against roughly one round trip
each over a socket. It is kept as the standby — if the public relays go dark,
swapping the import in `src/sync/trysteroTransport.ts` is the whole migration.

**When a relay is down,** Trystero reconnects on its own with backoff. Peers
already connected are unaffected — they stopped using it the moment they found
each other. A room whose relay is unreachable will not form until it returns;
that is the trade named above.

---

## Ads

YouTube serves ads per viewer. You get a thirty-second pre-roll, the other
person gets none — and if nothing notices, one of you watches half a minute of
advertising while the other watches half a minute of film, and you are never
together again.

So the room treats an ad as a reason to wait, exactly as it treats a buffering
connection: everyone else pauses, and the film starts again together when the ad
ends. The person watching it sees a small note saying the room is waiting; the
others are told it is an ad rather than a stall, because "buffering" sends people
off to check a connection that is working perfectly.

Two things make this harder than it sounds.

**Pausing an ad does not help.** It pauses the *ad* — the film is behind it and
never arrives — so a room waiting for that person would wait for ever. Play,
pause and seek are therefore dropped or deferred while an ad runs, and the ad is
allowed to finish. Anything the room asked for in the meantime lands the moment
the film is back.

**The API will not say when an ad is on.** There is no ad event, and during an
ad the player's own numbers describe the ad instead of the film. So it is
inferred, mostly from one reliable fact: while a video is *cued* — loaded but
not started — the player reports the real duration, and no ad can be in front of
it yet. That is the anchor, and anything that later disagrees with it is not our
video. If the anchor is missed, a duration change mid-playback gives the same
answer, and peers share the film's duration with each other so that somebody
stuck behind a pre-roll can still tell what they are looking at.

Because it is inference rather than an event, the wait is capped: if an ad state
somehow never clears, the room stops waiting after ninety seconds rather than
stalling the film for everybody. The "Wait for everyone" switch turns the whole
behaviour off.

One more consequence worth knowing: a YouTube embed only accepts eight fixed
playback speeds and rounds anything else back to 1×. The engine normally corrects
drift by running a few percent fast or slow, which nobody can hear — that does
nothing here, so for YouTube it corrects by seeking instead, and starts doing so
at a smaller drift than it would otherwise tolerate.

---

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:5173, enter a name, and start a room. To try syncing,
open the same room URL in a second browser window.

To test playback without a Drive file, generate a local clip with a burnt-in
timecode (so drift is visible by eye) and paste its URL into the app:

```bash
npm run sample:video
```

Then use `http://localhost:5173/sample.mp4` as the video link.

---

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run preview` | Serve the production build (`--host`, so you can open it on your phone) |
| `npm test` | Run the test suite once |
| `npm run test:watch` | Tests in watch mode |
| `npm run test:coverage` | Coverage for the sync engine and helpers |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run check` | **Everything above.** Run this before pushing. |
| `npm run sample:video` | Generate `public/sample.mp4` for local testing (needs ffmpeg) |

### Testing on a real phone

```bash
npm run preview
```

Vite prints a `http://192.168.x.x:4173` address. Open that on your phone while
it is on the same Wi-Fi. Note that some mobile browsers restrict WebRTC on
plain HTTP over a LAN address; if peers fail to connect, deploy and test against
the HTTPS URL instead.

---

## Testing strategy

The sync algorithm is the part most likely to break silently, so it is written
against interfaces rather than against the browser:

- `Transport` abstracts the WebRTC mesh. Tests use an in-memory network with
  controllable latency, jitter and per-peer clock skew.
- `MediaElementLike` abstracts `<video>`. Tests use a simulated element that
  models the three things that actually break real playback: decode rate is
  never exactly 1.0, the buffer can run dry, and autoplay can be refused.

Both run under a fake clock, so a five-minute watch party executes in
milliseconds and gives the same answer every time. The suite asserts on real
guarantees — "three peers with mismatched decode rates stay within 0.6s",
"a peer with a two-minute clock error does not jump ahead" — not on
implementation details.

Component tests cover the flows a user can get wrong: entering without a name,
pasting a folder link, pasting a file that is not shared.

CI runs typecheck → lint → test → build on every push
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

---

## Deploying

**Netlify.** The app is almost entirely static and signalling no longer needs a
backend at all, so a plain file host would very nearly work. What keeps it here
is `/api/turn`, which mints the short-lived TURN credentials that rescue the
pairs that cannot connect directly. Serve only files and most rooms still
connect; the ones on a symmetric NAT stop connecting, silently.

`netlify.toml` has everything: connect the repository and Netlify runs
`npm run build`, publishes `dist/`, and picks up the functions without further
configuration. The one rule worth knowing about is the redirect order — the
`/api/*` routes are declared *before* the single-page fallback, because a `/*`
rule that reaches them first would answer every request with the page itself.

**The signalling function is deployed but idle.** `netlify/functions/signal.ts`
is the standby described in [Finding each other](#finding-each-other). It costs
nothing while nothing calls it, and Netlify Blobs needs no setup for a site
deployed this way: the function requests its store by name and gets one.

The build uses relative asset paths, so it works from a subpath or a custom
domain with no configuration. `public/sample.mp4` is gitignored and only exists
locally, so it is never published — deploys are reproducible from the repo alone.

There is no GitHub Pages workflow any more: Pages has no way to run `/api/turn`,
so it would publish a build that quietly fails for exactly the people who need
help most. `.github/workflows/ci.yml` still runs typecheck → lint → test → build
on every push, which is what CI was for.

---

## Using it

1. **Enter your name.** Required before joining, so everyone knows who is who.
2. **Start a room**, or join with a code like `sunny-otter-42`.
3. **Share the code** — tap the room chip to copy the invite link.
4. **Paste a video link,** or on a computer, pick a file. A YouTube link of any
   shape (watch, `youtu.be`, Shorts, embed — a `?t=` start time is kept), Google
   Drive (*Share → General access → Anyone with the link*; if it is not shared,
   the app says so before loading), a put.io download link, any direct video
   URL, or an MP4 on your own disk — see
   [Playing a file off your own computer](#playing-a-file-off-your-own-computer).
5. **Watch.** Anyone can play, pause, or seek; everyone follows. On YouTube,
   clicking the picture plays and pauses for the room rather than for one
   screen.

Arrivals and departures show as a notice over the video, with a short chime,
so you notice them in fullscreen or on a phone without opening the panel. The
chime follows the video's mute button.

### Keyboard shortcuts (desktop)

| Key | Action |
| --- | --- |
| `Space` / `K` | Play / pause |
| `←` / `→` | Back / forward 10s |
| `F` | Fullscreen (`Esc` to leave) |
| `M` | Mute the video |

---

## Troubleshooting

**"Could not play this file."** The file is either not shared publicly, or it
is not a format browsers can play. MP4 with H.264 video and AAC audio works
everywhere. MKV, AVI, and HEVC generally do not.

**"The owner does not allow this video to be played outside YouTube."** Some
videos are watchable on youtube.com and nowhere else — the owner has turned
embedding off, which the room has no way around. If *Share → Embed* works on
YouTube, it works here.

**The YouTube player never appears.** The IFrame API is loaded from
`youtube.com`, so a content blocker or a network that filters YouTube stops it
before it starts; the app says so rather than sitting on a black rectangle.

**One of us is stuck on an ad and the room will not move.** It should clear when
the ad does. If the ad is skippable, the Skip button is inside the player and
belongs to whoever is watching it — nothing is covering it. Past ninety seconds
the room gives up waiting and carries on regardless, and "Wait for everyone" in
the panel turns the waiting off entirely.

**Fullscreen on an iPhone, watching YouTube.** Use the fullscreen button inside
the YouTube player rather than looking for ours — iPhone Safari will only put a
`<video>` into fullscreen, and YouTube's is sealed inside its iframe, so on that
one combination the embed keeps its own controls and ours is hidden. Play, pause
and seek from those controls still move the whole room.

**The YouTube video jumps a little instead of easing back into sync.** It has
to. A `<video>` can be nudged a few percent faster or slower without anyone
hearing it, but a YouTube embed only accepts its own fixed speeds, so the only
way back is a small seek.

**It played yesterday and not today.** Google Drive rate-limits downloads of
popular files ("Sorry, you can't view or download this file at this time").
Nothing in this app can work around that; wait, or copy the file to another
Drive account.

**A put.io link will not play.** Check that put.io has finished making its MP4
conversion — the original MKV/HEVC file cannot play in a browser. Note also that
put.io download URLs embed an account-wide `oauth_token`, and the link is shared
with everyone in the room; the app warns about this when it spots one.

**The film I shared from my computer stopped for everyone.** It plays out of
that tab, so it needs the tab open, in the room, and awake. Closing or reloading
the page ends the share and someone has to pick the file again — the others are
told that is what happened. A dropped connection is different and recovers on
its own.

**Someone joined and the room did not wait for them.** If their browser cannot
stream the shared file, it has to copy the whole thing across first, which is
minutes rather than seconds. Stopping the film for that would be worse than
letting them catch up, so the room carries on and they join at the current
point. Their entry in the participant list says *Copying the film across*.

**I cannot share a file from my phone.** That is deliberate — see
[Playing a file off your own computer](#playing-a-file-off-your-own-computer).
Watching one somebody else is sharing works on a phone.

**Peers never connect.** The chip says *Can't reach them · retrying*, and it
means it — a failed connection now rebuilds and tries again with backoff, so
give it a minute before doing anything. Open **Connection details** if it
persists: it says which of the three failures this is. With TURN credentials
configured even a symmetric NAT should get through, so a room that still will
not form usually means the deploy has no TURN key, or the relay this room's code
chose is unreachable — try a different room code, or a different network.

**My phone locked and the room lost me.** It should recover on its own within
a few seconds of unlocking — iOS tears down the connection while the screen is
off, and the app rebuilds it on waking. If it does not, reload the page.

**Voice chat asked for my microphone and I did not want it.** Turn it off in
the panel; the choice is remembered and it will not ask again.

**No voice audio on an iPhone.** iOS will not start audio until you have
interacted with the page, so tap anywhere — or use the "tap to hear" button if
it appears. This applies to whoever is *listening*, even if they never turn
their own microphone on.

**Voice chat will not turn on.** It needs microphone permission and an
`https://` page (or `localhost`). If the browser blocked it, the app says so —
re-allow the microphone in the site settings and press Turn on again.

**The other person hears the film echoing back.** Echo cancellation is on by
default and normally handles this. If it persists, it is usually speakers loud
enough to overwhelm the canceller — headphones fix it immediately.

**Everything is 20 seconds out of sync.** Check that both devices have
automatic time enabled. The app measures and corrects clock differences, but it
needs a moment; if it persists, one peer's video is probably still buffering.

---

## Known limits

See [ASSUMPTIONS.md](ASSUMPTIONS.md) for every decision made without you in the
room, and why.

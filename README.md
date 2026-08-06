# Watch Together

**Live: https://manak.github.io/BrowserWatchTogether/**

Watch a video in sync with someone else, on a phone or a laptop. No server, no
database, no accounts. Takes public Google Drive links, put.io links, or any
direct video URL.

Two people open the same room code, one pastes a link, and both players stay
locked to the same frame. Play, pause, and seek propagate to everyone; if one
person's connection stalls, the room waits for them and starts again together.
There is voice chat too, so you can talk over the film.

---

## How it works

```
  Browser A  ──────── WebRTC data channel ────────  Browser B
      │            (encrypted, direct, P2P)             │
      │                                                 │
      └── <video src="drive.usercontent.google.com/…">  ┘
                 (each browser downloads independently)
```

There is no backend. Two things make that possible:

**Finding each other.** [Trystero](https://github.com/dmotz/trystero) uses
public Nostr relays to exchange WebRTC connection offers. Once the browsers are
connected, every message travels directly between them. The relays only ever see
encrypted signalling blobs — the room code is the encryption password.

**Playing the video.** Each browser downloads the file straight into a plain
`<video>` element — from Google Drive's public download endpoint, from put.io,
or from any direct URL. No Drive API, no API key, no OAuth. These endpoints
support HTTP range requests, which is what makes seeking work.

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

### GitHub Pages (recommended — the app has no backend)

Every push to `main` triggers
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which runs the
full check suite, force-pushes the build output to the **`web`** branch, and
deploys it. That branch contains only generated files and is replaced wholesale
each time, so it never accumulates a history nobody reads.

One-time setup: **Settings → Pages → Source → GitHub Actions**.

The `web` branch exists so the deployed files are inspectable as ordinary
files, but Pages deploys the artifact from this workflow rather than building
from the branch. Branch mode makes GitHub run its own auto-generated builder,
which is opaque when it fails and races with this workflow over the same
commit — one workflow means one deployment and one place to look.

The site then lives at `https://manak.github.io/BrowserWatchTogether/`.

The build uses relative asset paths, so it works at both
`user.github.io/repo/` and a custom domain with no configuration.

Note that the workflow builds from a clean checkout, so `public/sample.mp4` —
which is gitignored and only exists locally — is never published. Deploys are
reproducible from the repo alone.

### Netlify

`netlify.toml` is ready: connect the repo and Netlify will run `npm run build`
and publish `dist/`. Nothing else is needed today. If a server ever does become
necessary, add TypeScript handlers under `netlify/functions/` and they will be
picked up automatically.

---

## Using it

1. **Enter your name.** Required before joining, so everyone knows who is who.
2. **Start a room**, or join with a code like `sunny-otter-42`.
3. **Share the code** — tap the room chip to copy the invite link.
4. **Paste a video link.** Google Drive (*Share → General access → Anyone with
   the link*; if it is not shared, the app says so before loading), a put.io
   download link, or any direct video URL.
5. **Watch.** Anyone can play, pause, or seek; everyone follows.

### Keyboard shortcuts (desktop)

| Key | Action |
| --- | --- |
| `Space` / `K` | Play / pause |
| `←` / `→` | Back / forward 10s |
| `F` | Fullscreen |
| `M` | Mute the video |

---

## Troubleshooting

**"Could not play this file."** The file is either not shared publicly, or it
is not a format browsers can play. MP4 with H.264 video and AAC audio works
everywhere. MKV, AVI, and HEVC generally do not.

**It played yesterday and not today.** Google Drive rate-limits downloads of
popular files ("Sorry, you can't view or download this file at this time").
Nothing in this app can work around that; wait, or copy the file to another
Drive account.

**A put.io link will not play.** Check that put.io has finished making its MP4
conversion — the original MKV/HEVC file cannot play in a browser. Note also that
put.io download URLs embed an account-wide `oauth_token`, and the link is shared
with everyone in the room; the app warns about this when it spots one.

**Peers never connect.** Some strict NATs and corporate firewalls block direct
WebRTC without a TURN relay, which this app deliberately does not include (it
would need a paid, always-on server). Try a different network or a phone
hotspot.

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

# How the sync works

The goal: two browsers, on different networks, downloading the same file
independently, showing the same frame — without ever stuttering to get there.

Nothing here needs a server. Every peer runs the same algorithm and reaches the
same conclusions from the same messages.

## The problem is three problems

**1. Wall clocks disagree.** Phones and laptops can be seconds apart. A message
saying "I am at 00:42 as of timestamp T" is useless if we disagree about what T
means.

**2. Decode rates disagree.** No two devices play a video at exactly 1.000x.
A 0.5% difference is 1.8 seconds per hour of drift, silently.

**3. Networks stall.** One person's buffer runs dry and they fall behind, or
their player pauses to rebuffer while everyone else carries on.

## Clock offset (`clockSync.ts`)

Each peer pings the others every 5 seconds and gets back the remote timestamp:

```
offset = t_remote − (t_sent + rtt/2)
```

We keep the last 8 samples and trust the one with the **lowest round trip**.
On a jittery link the fastest round trip is the one least distorted by queueing,
so its midpoint is the best estimate of the remote clock.

Until the first reply arrives we have no offset, so a remote timestamp is
meaningless — a phone whose clock is a minute out would fling us a minute out of
position. During that window we treat incoming messages as having been sent
"now". The error is then one network hop instead of an unbounded clock error.

## Who defines "now" in the film

The peer with the lowest id that has the video loaded is the **leader**. Every
peer computes this independently from information they all share, so there are
no election messages and handover on disconnect is instant.

The leader heartbeats its *actual* `video.currentTime` every 2 seconds. This is
the key choice: the reference is a real playhead, not a theoretical one, so the
leader's own decode drift is never something the others have to model.

The "has the video loaded" condition is not optional. Without it a newcomer with
a low id becomes leader the instant it joins and heartbeats a playhead of zero,
dragging everyone back to the start.

## Closing the gap (`drift.ts`)

Followers compare where they are to where the leader says the room is:

```
        |drift| < 0.15s   →  do nothing
0.15s < |drift| < 2.0s    →  adjust playbackRate, capped at ±10%
        |drift| > 2.0s    →  seek
```

The middle band is the interesting one. Playing at 1.05x for a few seconds is
imperceptible and, crucially, **never re-buffers**. Seeking always risks a
stall, so it is reserved for gaps too large to close smoothly. Corrections are
suspended for 1.2s after any seek while the element settles.

The deadband matters as much as the correction: without it, every peer would
chase network noise and judder permanently.

## Deliberate actions vs. drift

Play, pause, seek and media changes are **control events**, carrying a Lamport
counter. Higher counter wins; ties break on peer id. That means if two people
press opposite buttons in the same instant, every peer independently reaches the
same answer instead of flapping between the two.

Heartbeats carry the current counter but never change it, so a heartbeat that
was in flight when someone hit pause cannot undo the pause.

## Waiting for each other

Everyone reports their buffer depth. A peer is "ready" when it has decoded data
plus a couple of seconds ahead. If anyone is not ready, every peer pauses
locally — but the room's *intent* stays "playing", which is why the UI can say
"waiting for Sam" rather than just going quiet.

While the room is held, the leader heartbeats `advancing: false`, so everyone's
target freezes at the leader's playhead and they converge on the same frame
while stopped. When buffers recover, everyone is already in position and resumes
together.

Recovery requires a deeper buffer than the stall threshold (4s vs 2s). Without
that hysteresis the room would flap in and out of the waiting state on a
marginal connection.

A peer that goes silent is excluded from the gate after 30 seconds, so one
broken client cannot freeze the room forever.

The instant the room un-gates, the leader sends a heartbeat rather than waiting
for the next scheduled one. Without that, the leader plays while everyone else
is still following an anchor that says `advancing: false` — so they hold
position and, being behind a target that is not moving, get seeked *backwards*
until the next heartbeat sorts them out. A resume is exactly when the published
anchor stops being true, so that is when it gets republished.

## Ads

An ad is a fourth problem, and it only exists for YouTube: ads are served to
each viewer separately, so one person's playhead stops for thirty seconds while
everyone else's does not.

It is handled as a variety of "not ready" — the same gate that waits for a
buffering peer — with two differences. It is reported separately on the wire
(`ad` on the ready message) so the UI can say *"Sam has an ad"* rather than
*Buffering*, which otherwise sends people off to check a working connection.
And it is capped: unlike a stall, an ad is inferred rather than observed
(`youtube/adWatcher.ts`), so the room stops waiting after 90 seconds rather
than trusting an inference indefinitely.

A player showing an ad also reports a readyState below `HAVE_CURRENT_DATA`,
which excludes it from leadership — its playhead is frozen and its duration
belongs to the advert, so it cannot be the room's timing authority.

## Why this is testable

The engine talks to two interfaces, never to the browser:

- `Transport` — the message mesh. Tests supply an in-memory network with
  controllable latency, jitter, and per-peer clock skew.
- `MediaElementLike` — the video element. Tests supply a simulation that models
  imperfect decode rate, a finite buffer that can run dry, and refused autoplay.
  The YouTube embed is another implementation of the same interface, so it is
  driven by the identical code path — and a simulated one models the things
  that make it different: ads taking the player over, and a playback rate that
  refuses to be trimmed.

Both run under a fake clock. A five-minute watch party with three peers, two
decode rates and a stall executes in milliseconds and gives the same answer
every time.

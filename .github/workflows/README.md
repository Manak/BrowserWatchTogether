# Workflows

`ci.yml` runs typecheck → lint → test → build on every push.

There is no deploy workflow. Netlify builds and publishes from the repository
itself, and it has to: the app now depends on a function it deploys
(`netlify/functions/signal.ts`, the signalling relay), which no static host can
serve. A GitHub Pages deployment used to live here and was removed for exactly
that reason — it would have kept publishing a build where every room fails to
connect, with nothing on the page to explain why.

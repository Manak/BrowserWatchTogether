/*
 * Watch Together — serves a video that lives in somebody else's browser.
 *
 * When one person shares a file from their disk, the others have no URL to put
 * in a <video> element: the bytes are on a laptop, not on a host. This worker
 * invents that URL. It answers the video element's ordinary HTTP range requests
 * by asking the page for those bytes, and the page fetches them from the peer
 * that has the file.
 *
 * The point of doing it here rather than downloading the file first is that a
 * <video> then behaves exactly as it does with any other URL: playback starts
 * on the first chunk, memory stays bounded, and seeking is a range request
 * rather than a wait. That is what makes a phone a viable audience for a film
 * sitting on a laptop.
 *
 * Plain JavaScript and no build step, because it is served from `public/` as-is.
 * It caches nothing and touches no request that is not one of ours.
 */

/** Marks the URLs that belong to us. Must match `SHARE_PATH` in src/share. */
const PREFIX = '__wt-share'

/** Bounded so one request can never pull a whole film into memory. */
const MAX_SPAN = 512 * 1024

/** The page has to find the peer, ask it, and get the bytes back. */
const ANSWER_TIMEOUT_MS = 30000

self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return
  if (!url.pathname.includes(`/${PREFIX}/`)) return
  event.respondWith(serve(event))
})

async function serve(event) {
  const url = new URL(event.request.url)
  const shareId = decodeURIComponent(url.pathname.split('/').pop() || '')
  const size = Number(url.searchParams.get('size'))
  const mime = url.searchParams.get('mime') || 'video/mp4'

  if (!shareId || !Number.isFinite(size) || size <= 0) {
    return new Response('Not a share URL.', { status: 400 })
  }

  const range = parseRange(event.request.headers.get('Range'), size)

  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` },
    })
  }

  // No Range header at all. Rare for media — every browser that intends to seek
  // asks for one — but a download or a `fetch()` will do this, so stream the
  // file through rather than refusing.
  if (!range) {
    return new Response(sequentialStream(event, shareId, size), {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Content-Length': String(size),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
      },
    })
  }

  const end = Math.min(range.end, range.start + MAX_SPAN - 1)
  let bytes
  try {
    bytes = await ask(event, shareId, range.start, end)
  } catch (err) {
    return new Response(String((err && err.message) || err), { status: 503 })
  }

  // Answering with less than was asked for is legal, and is the whole trick:
  // the element simply comes back for the next piece, so memory stays flat and
  // a seek costs one chunk instead of a download.
  return new Response(bytes, {
    status: 206,
    headers: {
      'Content-Type': mime,
      'Content-Length': String(bytes.byteLength),
      'Content-Range': `bytes ${range.start}-${range.start + bytes.byteLength - 1}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    },
  })
}

/** `bytes=0-`, `bytes=100-199`, and `bytes=-500` (the last 500 bytes). */
function parseRange(header, size) {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match

  if (rawStart === '') {
    if (rawEnd === '') return null
    const suffix = Number(rawEnd)
    if (suffix <= 0) return 'unsatisfiable'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }

  const start = Number(rawStart)
  if (start >= size) return 'unsatisfiable'
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  if (end < start) return 'unsatisfiable'
  return { start, end }
}

/** The body for a request that did not ask for a range: chunk after chunk. */
function sequentialStream(event, shareId, size) {
  let offset = 0
  return new ReadableStream({
    async pull(controller) {
      if (offset >= size) {
        controller.close()
        return
      }
      try {
        const bytes = await ask(
          event,
          shareId,
          offset,
          Math.min(size - 1, offset + MAX_SPAN - 1),
        )
        offset += bytes.byteLength
        controller.enqueue(new Uint8Array(bytes))
      } catch (err) {
        controller.error(err)
      }
    },
  })
}

/**
 * Ask the page for bytes. The page owns the peer connection; this worker owns
 * the URL. One MessageChannel per request keeps the answers matched to their
 * questions without inventing request ids.
 */
async function ask(event, shareId, start, end) {
  const client = await clientFor(event)
  if (!client) throw new Error('The tab sharing this file is not open.')

  return new Promise((resolve, reject) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => {
      channel.port1.close()
      reject(new Error('Timed out waiting for the file.'))
    }, ANSWER_TIMEOUT_MS)

    channel.port1.onmessage = (msg) => {
      clearTimeout(timer)
      channel.port1.close()
      const data = msg.data || {}
      if (data.ok && data.bytes) resolve(data.bytes)
      else reject(new Error(data.error || 'Could not fetch that part of the file.'))
    }

    client.postMessage({ type: 'wt-range', shareId, start, end }, [channel.port2])
  })
}

/**
 * The tab that made the request, or any of ours if the browser did not say —
 * media requests do not always carry a client id, and every tab of this app can
 * answer for the room it is in.
 */
async function clientFor(event) {
  if (event.clientId) {
    const exact = await self.clients.get(event.clientId)
    if (exact) return exact
  }
  const windows = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })
  return windows[0] || null
}

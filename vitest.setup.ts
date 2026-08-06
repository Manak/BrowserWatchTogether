import '@testing-library/jest-dom/vitest'

// jsdom ships no media pipeline, so these throw "Not implemented" by default.
// Stub them so component tests can render and drive a <video> element.
for (const [name, impl] of [
  ['play', () => Promise.resolve()],
  ['pause', () => undefined],
  ['load', () => undefined],
] as const) {
  Object.defineProperty(HTMLMediaElement.prototype, name, {
    configurable: true,
    writable: true,
    value: impl,
  })
}

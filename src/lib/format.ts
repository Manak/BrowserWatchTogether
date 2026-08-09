export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return h > 0
    ? `${h}:${mm}:${String(s).padStart(2, '0')}`
    : `${mm}:${String(s).padStart(2, '0')}`
}

/** File sizes, in the units a person would use out loud. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const gb = bytes / 1e9
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`
  const mb = bytes / 1e6
  if (mb >= 1) return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`
}

/** Stable, pleasant colour per participant, derived from their peer id. */
export function colorForId(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return `hsl(${h % 360} 70% 62%)`
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase()
  return ((parts[0] as string)[0]! + (parts[parts.length - 1] as string)[0]!).toUpperCase()
}

export function sanitizeName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 24)
}

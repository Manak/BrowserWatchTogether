import { useCallback, useState } from 'react'

/** localStorage-backed state that degrades gracefully in private browsing. */
export function useLocalStorage(
  key: string,
  initial: string,
): [string, (v: string) => void] {
  const [value, setValue] = useState<string>(() => {
    try {
      return localStorage.getItem(key) ?? initial
    } catch {
      return initial
    }
  })

  const set = useCallback(
    (v: string) => {
      setValue(v)
      try {
        localStorage.setItem(key, v)
      } catch {
        // Safari private mode throws on write; keeping it in memory is fine.
      }
    },
    [key],
  )

  return [value, set]
}

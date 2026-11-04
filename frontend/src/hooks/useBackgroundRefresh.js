import { useEffect, useRef } from 'react'

// User actions load immediately. This is only the fallback for worker changes.
export default function useBackgroundRefresh(refresh, interval = 60_000) {
  const latest = useRef(refresh)
  latest.current = refresh
  useEffect(() => {
    let stopped = false
    let running = false
    const run = async () => {
      if (stopped || running || document.visibilityState !== 'visible') return
      running = true
      try { await latest.current() } finally { running = false }
    }
    const visible = () => { if (document.visibilityState === 'visible') void run() }
    const timer = setInterval(run, interval)
    document.addEventListener('visibilitychange', visible)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [interval])
}

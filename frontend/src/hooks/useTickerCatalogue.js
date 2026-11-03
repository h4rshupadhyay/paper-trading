import { useEffect, useState } from 'react'
import { loadTickerCatalogue } from '../services/tickerCatalogue'

export default function useTickerCatalogue() {
  const [catalogue, setCatalogue] = useState(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let active = true
    loadTickerCatalogue()
      .then(data => { if (active) setCatalogue(data) })
      // Suggestions are optional: manual input/remote search remain available.
      .catch(() => {})
    return () => { active = false }
  }, [attempt])

  const retry = () => { if (catalogue === null) setAttempt(value => value + 1) }
  return { catalogue, retry }
}

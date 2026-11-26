import { useEffect, useState } from 'react'

import { watchReducedTransparency } from './reducedTransparency'

export function useNavTransparency(): boolean {
  const [reduced, setReduced] = useState(false)
  useEffect(() => watchReducedTransparency(setReduced), [])
  return reduced
}

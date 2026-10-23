import React, { act, useState } from 'react'

import { SceneShownProvider } from '../app/components/sceneShown'

let setShown: ((shown: boolean) => void) | undefined

/** A scene a test can cover and show again, as the stack navigator does. */
export function CoverableScene(props: {
  children: React.ReactNode
}): React.ReactElement {
  const [shown, set] = useState(true)
  setShown = set
  return <SceneShownProvider value={shown}>{props.children}</SceneShownProvider>
}

/** A screen pushed over the scene, and Back from it. */
export async function coverAndReveal(
  meanwhile?: () => void | Promise<void>
): Promise<void> {
  await act(async () => {
    setShown?.(false)
  })
  await meanwhile?.()
  await act(async () => {
    setShown?.(true)
    await new Promise(resolve => setTimeout(resolve, 20))
  })
}

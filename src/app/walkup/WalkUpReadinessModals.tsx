import React from 'react'

import { AppleMusicSetup } from './AppleMusicSetup'
import { SongsNotDownloadedModal } from './SongsNotDownloadedModal'
import type { Readiness } from './walkUpReadiness'

/**
 * The walkthrough and the notice a screen's `useWalkUpReadiness` drives.
 * Each mounts once it has opened on the visit and stays mounted, so it can
 * animate away and say when it has gone; a visit that needs neither mounts
 * nothing.
 */
export function WalkUpReadinessModals(props: {
  readiness: Readiness
}): React.ReactElement {
  const {
    setupOpen,
    promptOpen,
    setupUsed,
    promptUsed,
    openSetup: handleSettings,
    closeSetup: handleSetupClose,
    closePrompt: handlePromptClose,
    onPromptShown: handlePromptShown
  } = props.readiness
  return (
    <>
      {setupUsed && (
        <AppleMusicSetup visible={setupOpen} onClose={handleSetupClose} />
      )}
      {promptUsed && (
        <SongsNotDownloadedModal
          visible={promptOpen}
          onClose={handlePromptClose}
          onSettings={handleSettings}
          onShow={handlePromptShown}
        />
      )}
    </>
  )
}

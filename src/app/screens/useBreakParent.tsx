import React, { useState } from 'react'

import type { TeamStationClient } from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import type { ParentPreview } from '../../common/groupLinks'
import { BreakParentSheet } from '../components/BreakParentSheet'

/**
 * Breaking a child's parent link from a league or season page: ask the
 * server what would change, show that in the sheet, and apply exactly the
 * reviewed preview when the person confirms.
 */
export function useBreakParent(
  client: TeamStationClient,
  onBroken: () => void
): {
  review: (child: GroupRef, parent: GroupRef) => void
  sheet: React.ReactNode
  error: string
} {
  const [preview, setPreview] = useState<ParentPreview>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sheetError, setSheetError] = useState('')
  const review = (child: GroupRef, parent: GroupRef): void => {
    setError('')
    setSheetError('')
    client
      .parentPreview([{ operation: 'detach', child, parent }])
      .then(setPreview, (caught: unknown) => {
        setError(
          caught instanceof Error
            ? caught.message
            : 'The relationship could not be reviewed. Retry.'
        )
      })
  }
  const apply = (): void => {
    if (preview == null || busy) return
    setBusy(true)
    setSheetError('')
    client
      .changeParents(preview)
      .then(
        () => {
          setPreview(undefined)
          onBroken()
        },
        (caught: unknown) => {
          setSheetError(
            caught instanceof Error
              ? caught.message
              : 'The relationship could not be removed. Retry.'
          )
        }
      )
      .finally(() => {
        setBusy(false)
      })
  }
  return {
    review,
    error,
    sheet:
      preview == null ? null : (
        <BreakParentSheet
          preview={preview}
          busy={busy}
          error={sheetError}
          onBreak={apply}
          onKeep={() => {
            setPreview(undefined)
            setSheetError('')
          }}
        />
      )
  }
}

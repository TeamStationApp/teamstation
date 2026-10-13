import React, { useState } from 'react'

import type { TeamStationClient } from '../../common/api'
import type { GroupRef } from '../../common/groupCreation'
import type { ParentPreview } from '../../common/groupLinks'
import type { BreakParentSheetProps } from '../components/BreakParentSheet'
import { BreakParentSheet } from '../components/BreakParentSheet'
import { useLatestRequest } from '../hooks/useLatestRequest'

/**
 * Breaking a child's parent link from a league or season page: ask the
 * server what would change, show that in the sheet, and apply exactly the
 * reviewed preview when the person confirms.
 */
export function useBreakParent(
  client: TeamStationClient,
  onBroken: () => void,
  copy: Partial<
    Pick<
      BreakParentSheetProps,
      'title' | 'warning' | 'confirmLabel' | 'cancelLabel' | 'danger'
    >
  > = {}
): {
  review: (child: GroupRef, parent: GroupRef) => void
  sheet: React.ReactNode
  error: string
  busy: boolean
} {
  const [preview, setPreview] = useState<ParentPreview>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sheetError, setSheetError] = useState('')
  const [reviewing, setReviewing] = useState(false)
  const begin = useLatestRequest()
  const review = (child: GroupRef, parent: GroupRef): void => {
    setError('')
    setSheetError('')
    setReviewing(true)
    const current = begin()
    client
      .parentPreview([{ operation: 'detach', child, parent }])
      .then(
        value => {
          if (current()) setPreview(value)
        },
        (caught: unknown) => {
          if (current())
            setError(
              caught instanceof Error
                ? caught.message
                : 'The relationship could not be reviewed. Retry.'
            )
        }
      )
      .finally(() => {
        if (current()) setReviewing(false)
      })
  }
  const apply = (): void => {
    if (preview == null || busy) return
    const current = begin()
    setBusy(true)
    setSheetError('')
    client
      .changeParents(preview)
      .then(
        () => {
          if (!current()) return
          setPreview(undefined)
          onBroken()
        },
        (caught: unknown) => {
          if (!current()) return
          setSheetError(
            caught instanceof Error
              ? caught.message
              : 'The relationship could not be removed. Retry.'
          )
        }
      )
      .finally(() => {
        if (current()) setBusy(false)
      })
  }
  return {
    review,
    error,
    busy: busy || reviewing,
    sheet:
      preview == null ? null : (
        <BreakParentSheet
          {...copy}
          preview={preview}
          busy={busy}
          error={sheetError}
          onBreak={apply}
          onKeep={() => {
            begin()
            setPreview(undefined)
            setSheetError('')
          }}
        />
      )
  }
}

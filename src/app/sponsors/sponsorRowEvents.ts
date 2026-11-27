import { useCallback, useEffect, useRef, useState } from 'react'

import type { AnalyticsClient } from '../../common/observability/analyticsClient'
import type { SponsoredRow } from '../../common/sponsors/types'
import { useAnalytics } from '../observability/AnalyticsContext'
import { deviceId } from '../stream/deviceId'
import { sponsoredKey } from './sponsoredRows'
import { ROW_VIEW_MS, viewTimers } from './viewTimers'

/** A sponsored row as its events name it. */
export type TrackedRow = Pick<SponsoredRow, 'id' | 'leagueId'>

/**
 * Records a sponsored row's view or tap: the row and its league, and, for a
 * signed-out visitor, this device's id (`dv`), since there is no user to
 * store. Signed in, the server stores the user.
 */
export async function sendRowEvent(
  analytics: AnalyticsClient | undefined,
  event: 'sponsor_row_viewed' | 'sponsor_row_tapped',
  row: TrackedRow,
  device: () => Promise<string> = deviceId
): Promise<void> {
  if (analytics == null) return
  const properties: Record<string, string> = { er: row.id, lg: row.leagueId }
  if (!analytics.identified) {
    try {
      properties.dv = await device()
    } catch {
      // Recorded without it: the row was still seen.
    }
  }
  await analytics.emit(event, properties)
}

/**
 * What a Schedule list hands `PagedList`'s `onViewableKeys`: each of its
 * sponsored rows that stays on screen for five seconds is recorded as a view
 * (`viewTimers`). `rows` are the Schedule's sponsored rows, which the keys
 * are looked up in; other keys are the list's own and are let be.
 */
export function useSponsoredRowViews(
  rows: readonly SponsoredRow[],
  ms = ROW_VIEW_MS
): (keys: readonly string[]) => void {
  const analytics = useAnalytics()
  const latest = useRef({ analytics, rows })
  latest.current = { analytics, rows }
  const [timers] = useState(() =>
    viewTimers(
      key => {
        const { analytics, rows } = latest.current
        const row = rows.find(
          row => sponsoredKey({ kind: 'sponsored', row }) === key
        )
        if (row != null)
          sendRowEvent(analytics, 'sponsor_row_viewed', row).catch(
            () => undefined
          )
      },
      { ms }
    )
  )
  useEffect(
    () => () => {
      timers.stop()
    },
    [timers]
  )
  return useCallback(
    (keys: readonly string[]) => {
      timers.update(keys.filter(key => key.startsWith('sponsored:')))
    },
    [timers]
  )
}

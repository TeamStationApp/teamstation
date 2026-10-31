import React from 'react'
import {
  ActivityIndicator,
  type StyleProp,
  Text,
  View,
  type ViewStyle
} from 'react-native'

import type { PagedRows } from '../hooks/usePagedList'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

type Ends = Pick<
  PagedRows<unknown>,
  'loadingMore' | 'failed' | 'failedWay' | 'retry'
>

/**
 * What a list shows after its last row: the spinner while the next page is on
 * its way, and when it could not be read, a Retry. The rows stay where they
 * are either way, and nothing reads again until Retry or the next time the
 * reader reaches the end. An older page that failed has its Retry at the top,
 * with `PagedListStart`, not here.
 */
export function PagedListEnd(props: { list: Ends }): React.ReactElement | null {
  const { loadingMore, failed, failedWay, retry } = props.list
  const styles = getStyles(useTheme())
  if (failed && failedWay !== 'previous')
    return <Failed testID="paged-list-end-failed" retry={retry} />
  if (loadingMore)
    return (
      <View style={styles.end}>
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
    )
  return null
}

/**
 * What a list that reads older rows shows above its first row: a Retry when
 * the older page could not be read. The rows stay where they are, and
 * nothing reads up again until Retry or the reader reaches the top again.
 */
export function PagedListStart(props: {
  list: Pick<Ends, 'failedWay' | 'retry'>
}): React.ReactElement | null {
  const { failedWay, retry } = props.list
  if (failedWay !== 'previous') return null
  return <Failed testID="paged-list-start-failed" retry={retry} />
}

/**
 * What a list with no rows shows, as its `empty`: the spinner while its first
 * page is on its way, then `none` when it holds nothing. A first page that
 * could not be read shows its failure, unless the screen writes it already,
 * and Retry, which reads the first page again.
 */
export function PagedListEmpty(props: {
  list: Pick<PagedRows<unknown>, 'loading' | 'empty' | 'error' | 'refresh'>
  /** What the list says when it holds nothing. */
  none: React.ReactNode
  /** The spinner's accessibility label. */
  loadingLabel?: string
  spinnerStyle?: StyleProp<ViewStyle>
  /** What a failure with no message of its own says. */
  failure?: string
  /** Off where the screen already says what failed: Retry alone shows. */
  saysFailure?: boolean
  /** What Retry does, when it is not reading the list's first page again. */
  onRetry?: () => void
}): React.ReactElement | null {
  const { list, none, loadingLabel = 'Loading', spinnerStyle } = props
  const { failure = 'Cannot load', saysFailure = true, onRetry } = props
  const { loading, empty, error, refresh } = list
  const styles = getStyles(useTheme())
  if (loading)
    return (
      <ActivityIndicator
        accessibilityLabel={loadingLabel}
        style={spinnerStyle}
      />
    )
  if (error != null)
    return (
      <View testID="paged-list-empty-failed" style={styles.end}>
        {saysFailure && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error instanceof Error ? error.message : failure}
          </Text>
        )}
        <Button
          label={lstrings.paged_list_retry}
          kind="secondary"
          onPress={() => {
            if (onRetry != null) onRetry()
            else refresh().catch(() => undefined)
          }}
        />
      </View>
    )
  return empty ? <>{none}</> : null
}

function Failed(props: {
  testID: string
  retry: () => Promise<void>
}): React.ReactElement {
  const { testID, retry } = props
  const styles = getStyles(useTheme())
  return (
    <View testID={testID} style={styles.end}>
      <Text style={styles.note}>{lstrings.paged_list_load_failed}</Text>
      <Button
        label={lstrings.paged_list_retry}
        kind="secondary"
        onPress={() => {
          retry().catch(() => undefined)
        }}
      />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  end: {
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceMdRem)
  },
  note: {
    color: theme.secondaryTextColor
  },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  }
}))

import React from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import type { PagedRows } from '../hooks/usePagedList'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

/**
 * What a list shows after its last row: the spinner while the next page is on
 * its way, and when it could not be read, a Retry. The rows stay where they
 * are either way, and nothing reads again until Retry or the next time the
 * reader reaches the end.
 */
export function PagedListEnd(props: {
  list: Pick<PagedRows<unknown>, 'loadingMore' | 'failed' | 'retry'>
}): React.ReactElement | null {
  const { loadingMore, failed, retry } = props.list
  const styles = getStyles(useTheme())
  if (failed)
    return (
      <View style={styles.end}>
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
  if (loadingMore)
    return (
      <View style={styles.end}>
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
    )
  return null
}

const getStyles = cacheStyles((theme: Theme) => ({
  end: {
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceMdRem)
  },
  note: {
    color: theme.secondaryTextColor
  }
}))

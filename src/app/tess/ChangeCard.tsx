import React, { useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'

import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { HoldToConfirm } from './HoldToConfirm'
import type { TessChange, TessChangeStatus } from './tessTypes'

const MONOSPACE = Platform.OS === 'ios' ? 'ui-monospace' : 'monospace'

/** What became of a change, or nothing while it can still be confirmed. */
function outcomeOf(status: TessChangeStatus): string | undefined {
  if (status === 'done') return lstrings.tess_change_done
  if (status === 'failed') return lstrings.tess_change_failed
  if (status === 'expired') return lstrings.tess_change_expired
  if (status === 'unknown') return lstrings.tess_change_unknown
}

/**
 * A change Tess proposed. Under her summary is what the server will run, from
 * the row it stored rather than her words: the method and path, and the body
 * when there is one. Confirm is held while the change waits, and not while
 * Tess is answering; afterwards the card says how it went, or, for one the
 * server lost track of mid-run, to check whether it happened.
 */
export function ChangeCard({
  change,
  onConfirm,
  holdDisabled = false
}: {
  change: TessChange
  onConfirm: (changeId: string) => void
  /** Tess is answering: no change is confirmed until she has. */
  holdDisabled?: boolean
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [bodyOpen, setBodyOpen] = useState(true)
  const outcome = outcomeOf(change.status)
  return (
    <View testID="Tess change" style={styles.card}>
      <Text style={styles.summary}>{change.summary}</Text>
      <Text selectable testID="Tess change request" style={styles.request}>
        {`${change.method} ${change.path}`}
      </Text>
      {change.body != null && (
        <View style={styles.body}>
          <Pressable
            accessibilityRole="button"
            aria-expanded={bodyOpen}
            onPress={() => {
              setBodyOpen(open => !open)
            }}
            style={styles.bodyToggle}
          >
            <View style={bodyOpen && styles.open}>
              <Icon
                name="chevron_right"
                size={1}
                color={theme.secondaryTextColor}
              />
            </View>
            <Text style={styles.bodyLabel}>{lstrings.tess_change_body}</Text>
          </Pressable>
          {bodyOpen && (
            <Text selectable testID="Tess change body" style={styles.json}>
              {JSON.stringify(change.body, null, 2)}
            </Text>
          )}
        </View>
      )}
      {outcome == null ? (
        <HoldToConfirm
          busy={change.status === 'running'}
          disabled={holdDisabled}
          onConfirm={() => {
            onConfirm(change.id)
          }}
        />
      ) : (
        <Text
          testID="Tess change status"
          style={[
            styles.outcome,
            change.status === 'done' ? styles.done : styles.notDone
          ]}
        >
          {outcome}
        </Text>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    gap: theme.rem(theme.spaceSmRem),
    padding: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.cardBackgroundColor
  },
  summary: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600',
    color: theme.primaryTextColor
  },
  request: {
    fontFamily: MONOSPACE,
    fontSize: theme.rem(0.8125),
    color: theme.primaryTextColor
  },
  body: {
    borderRadius: theme.rem(theme.radiusSmallRem),
    backgroundColor: theme.inactiveBackgroundColor,
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingBottom: theme.rem(theme.spaceSmRem)
  },
  bodyToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem),
    minHeight: theme.rem(2.25)
  },
  open: { transform: [{ rotate: '90deg' }] },
  bodyLabel: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  json: {
    fontFamily: MONOSPACE,
    fontSize: theme.rem(0.75),
    lineHeight: theme.rem(1.0625),
    color: theme.primaryTextColor
  },
  outcome: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    fontWeight: '600'
  },
  done: { color: theme.successColor },
  notDone: { color: theme.dangerColor }
}))

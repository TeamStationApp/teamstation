import React, { useState } from 'react'
import { Platform, Pressable, Text, View } from 'react-native'

import { ButtonIcon } from '../components/ButtonIcon'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  cellsOf,
  changeTableHtml,
  changeTables,
  columnsOf,
  columnWeights,
  outcomeOf,
  showsStatus
} from './changeTable'
import { HoldToConfirm } from './HoldToConfirm'
import { RichViewer } from './RichViewer'
import { useTessOverlay } from './TessOverlay'
import type { TessChange } from './tessTypes'

const MONOSPACE = Platform.OS === 'ios' ? 'ui-monospace' : 'monospace'

/**
 * The changes one turn of Tess's proposed, under her last reply of it: a
 * table in plain words for each run of changes that give the same details
 * (`changeTables`), each change a row, and one Confirm held for all those
 * still waiting. What the server will run, from the rows it stored rather
 * than her words, is folded under "Request details": each change's method,
 * path and body. Once any change has ended the tables gain a Status column
 * (Done, Failed, Expired, or Check for one the server lost track of, with a
 * note to check whether it happened). Confirm takes no hold while Tess is
 * answering. On a wide screen, Expand, beside Confirm, opens the tables over
 * the pane beside the chat.
 */
export function ChangeBatch({
  changes,
  onConfirmAll,
  holdDisabled = false
}: {
  changes: TessChange[]
  /** Runs these changes, the batch's still pending, in order. */
  onConfirmAll: (changeIds: string[]) => void
  /** Tess is answering: nothing is confirmed until she has. */
  holdDisabled?: boolean
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const overlay = useTessOverlay()
  const [requestsOpen, setRequestsOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const withStatus = showsStatus(changes)
  const pending = changes.filter(change => change.status === 'pending')
  const running = changes.some(change => change.status === 'running')
  const unknown = changes.some(change => change.status === 'unknown')
  const holding = pending.length > 0 || running
  return (
    <View testID="Tess changes" style={styles.card}>
      {changeTables(changes).map(table => {
        // Every row's cells share the same proportions, so columns line up.
        const widths = columnWeights(table).map(weight => ({
          flexGrow: weight
        }))
        return (
          <View
            key={table.changes[0].id}
            testID="Tess change table"
            style={styles.table}
          >
            <View style={styles.row}>
              {columnsOf(table, withStatus).map((column, at, all) => (
                <Text
                  key={at}
                  numberOfLines={2}
                  style={[
                    styles.cell,
                    styles.heading,
                    withStatus && at === all.length - 1
                      ? styles.status
                      : widths[at]
                  ]}
                >
                  {column}
                </Text>
              ))}
            </View>
            {table.changes.map(change => {
              const outcome = outcomeOf(change.status)
              return (
                <View
                  key={change.id}
                  testID="Tess change"
                  style={[styles.row, styles.divided]}
                >
                  {cellsOf(change).map((cell, at) => (
                    <Text
                      key={at}
                      selectable
                      numberOfLines={2}
                      style={[styles.cell, styles.value, widths[at]]}
                    >
                      {cell}
                    </Text>
                  ))}
                  {withStatus && (
                    <Text
                      testID="Tess change status"
                      numberOfLines={2}
                      style={[
                        styles.cell,
                        styles.status,
                        styles.outcome,
                        change.status === 'done'
                          ? styles.done
                          : outcome != null && styles.notDone
                      ]}
                    >
                      {outcome ?? ''}
                    </Text>
                  )}
                </View>
              )
            })}
          </View>
        )
      })}
      {unknown && (
        <Text style={styles.note}>{lstrings.tess_change_unknown}</Text>
      )}
      <View style={styles.requests}>
        <Pressable
          accessibilityRole="button"
          aria-expanded={requestsOpen}
          onPress={() => {
            setRequestsOpen(open => !open)
          }}
          style={styles.requestsToggle}
        >
          <View style={requestsOpen && styles.open}>
            <ButtonIcon
              name="chevron_right"
              size={1}
              color={theme.secondaryTextColor}
            />
          </View>
          <Text style={styles.requestsLabel}>
            {lstrings.tess_change_requests}
          </Text>
        </Pressable>
        {requestsOpen &&
          changes.map(change => (
            <View key={change.id} style={styles.request}>
              <Text
                selectable
                testID="Tess change request"
                style={styles.method}
              >
                {`${change.method} ${change.path}`}
              </Text>
              {change.body != null && (
                <Text selectable testID="Tess change body" style={styles.json}>
                  {JSON.stringify(change.body, null, 2)}
                </Text>
              )}
            </View>
          ))}
      </View>
      {(holding || overlay != null) && (
        <View style={styles.footer}>
          {holding && (
            <HoldToConfirm
              busy={pending.length === 0}
              disabled={holdDisabled}
              onConfirm={() => {
                onConfirmAll(pending.map(change => change.id))
              }}
            />
          )}
          {overlay != null && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lstrings.tess_change_expand_label}
              onPress={() => {
                setExpanded(true)
              }}
              style={({ pressed }) => [
                styles.expand,
                pressed && styles.pressed
              ]}
            >
              <ButtonIcon
                name="fullscreen"
                size={1}
                color={theme.secondaryTextColor}
              />
              <Text style={styles.expandText}>
                {lstrings.tess_change_expand}
              </Text>
            </Pressable>
          )}
        </View>
      )}
      {expanded && (
        <RichViewer
          html={changeTableHtml(changes)}
          onClose={() => {
            setExpanded(false)
          }}
        />
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
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(theme.spaceSmRem)
  },
  expand: {
    marginLeft: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem),
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(theme.spaceSmRem)
  },
  expandText: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  pressed: { opacity: 0.6 },
  table: { alignSelf: 'stretch' },
  row: { flexDirection: 'row' },
  divided: {
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor
  },
  // Each column's share of the card is its weight (`columnWeights`), a long
  // value wrapping onto a second line.
  cell: {
    flexShrink: 1,
    flexBasis: 0,
    minWidth: 0,
    paddingVertical: theme.rem(theme.spaceXsRem),
    paddingRight: theme.rem(theme.spaceSmRem),
    fontSize: theme.rem(0.8125),
    lineHeight: theme.rem(1.125)
  },
  heading: {
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '600',
    color: theme.secondaryTextColor
  },
  value: {
    fontFamily: theme.regularTextFont,
    color: theme.primaryTextColor
  },
  // The Status column: as wide as its longest word, so the columns of plain
  // words share the rest.
  status: {
    flexGrow: 0,
    flexShrink: 0,
    flexBasis: 'auto',
    width: theme.rem(4)
  },
  outcome: {
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '600'
  },
  done: { color: theme.successColor },
  notDone: { color: theme.dangerColor },
  note: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.dangerColor
  },
  requests: {
    borderRadius: theme.rem(theme.radiusSmallRem),
    backgroundColor: theme.inactiveBackgroundColor,
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingBottom: theme.rem(theme.spaceXsRem)
  },
  requestsToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceXsRem),
    minHeight: theme.rem(2.25)
  },
  open: { transform: [{ rotate: '90deg' }] },
  requestsLabel: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  request: {
    gap: theme.rem(theme.spaceXsRem),
    paddingBottom: theme.rem(theme.spaceSmRem)
  },
  method: {
    fontFamily: MONOSPACE,
    fontSize: theme.rem(0.8125),
    color: theme.primaryTextColor
  },
  json: {
    fontFamily: MONOSPACE,
    fontSize: theme.rem(0.75),
    lineHeight: theme.rem(1.0625),
    color: theme.primaryTextColor
  }
}))

import React, { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { TRY_AGAIN, USE_SERVER_COPY } from '../scoring/HeldGameNotice'
import {
  HELD_GAME_UNNAMED,
  HELD_TEAM_UNNAMED,
  type HeldEdit,
  heldEditKey,
  heldEditText,
  SERVER_COPY_PENDING
} from '../sync/useOffline'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { CancelAction } from './CancelAction'
import { Sheet } from './Sheet'

export interface HeldEditActions {
  /** Sends the held queue again, from where the server stopped. */
  retry: (edit: HeldEdit) => Promise<void>
  /**
   * Deletes what the phone holds for it and reads the server's copy;
   * whether that copy came back.
   */
  discard: (edit: HeldEdit) => Promise<boolean>
}

export interface HeldEditsSheetProps {
  /** Every held queue on the phone (`heldEdits`). */
  edits: HeldEdit[]
  /** Their names by `heldEditKey` (`useHeldNames`). */
  names: Record<string, string>
  actions: HeldEditActions
  onClose: () => void
}

export const HELD_EDITS_TITLE = 'Edits Not Sent'

/** A held queue's name, or what stands for one the phone cannot name. */
export function heldEditName(
  edit: HeldEdit,
  names: Record<string, string>
): string {
  return (
    names[heldEditKey(edit)] ??
    (edit.kind === 'game' ? HELD_GAME_UNNAMED : HELD_TEAM_UNNAMED)
  )
}

/**
 * What the not-sent banner opens: every game and team whose edits the
 * server stopped, each by name with what the server said, and for each a
 * way to send them again or to take the server's copy. It closes itself
 * once nothing is held; Cancel changes nothing.
 */
export function HeldEditsSheet(
  props: HeldEditsSheetProps
): React.ReactElement | null {
  const { edits, names, actions, onClose } = props
  const styles = getStyles(useTheme())
  const empty = edits.length === 0
  useEffect(() => {
    if (empty) onClose()
  }, [empty, onClose])
  if (empty) return null
  return (
    <Sheet
      onClose={onClose}
      closeLabel="Close"
      testID="heldEditsSheet"
      style={styles.sheet}
    >
      <Text style={styles.title}>{HELD_EDITS_TITLE}</Text>
      {edits.map(edit => (
        <HeldEditRow
          key={heldEditKey(edit)}
          edit={edit}
          name={heldEditName(edit, names)}
          actions={actions}
        />
      ))}
      <CancelAction label="Cancel" onPress={onClose} />
    </Sheet>
  )
}

function HeldEditRow(props: {
  edit: HeldEdit
  name: string
  actions: HeldEditActions
}): React.ReactElement {
  const { edit, name, actions } = props
  const styles = getStyles(useTheme())
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string>()
  const run = (work: () => Promise<string | undefined>): void => {
    if (busy) return
    setBusy(true)
    setProblem(undefined)
    work()
      .then(next => {
        setProblem(next)
      })
      .catch((caught: unknown) => {
        setProblem(
          caught instanceof Error ? caught.message : 'That did not work. Retry.'
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }
  const button = (
    label: string,
    destructive: boolean,
    work: () => Promise<string | undefined>
  ): React.ReactElement => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${name}`}
      accessibilityState={{ disabled: busy }}
      disabled={busy}
      onPress={() => {
        run(work)
      }}
      style={({ pressed }) => [
        styles.action,
        (pressed || busy) && styles.pressed
      ]}
    >
      <Text style={[styles.actionLabel, destructive && styles.destructive]}>
        {label}
      </Text>
    </Pressable>
  )
  return (
    <View testID={`heldEdit-${edit.kind}-${edit.id}`} style={styles.row}>
      <Text style={styles.name}>{name}</Text>
      <Text style={styles.detail}>{heldEditText(edit)}</Text>
      {problem != null && (
        <Text accessibilityRole="alert" style={styles.problem}>
          {problem}
        </Text>
      )}
      <View style={styles.actions}>
        {button(TRY_AGAIN, false, async () => {
          await actions.retry(edit)
          return undefined
        })}
        {button(USE_SERVER_COPY, true, async () =>
          (await actions.discard(edit)) ? undefined : SERVER_COPY_PENDING
        )}
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  // The card, title and rows of the app's other sheets (`ChoiceSheet`).
  sheet: {
    backgroundColor: theme.cardBackgroundColor,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: theme.rem(theme.spaceLgRem),
    gap: theme.rem(theme.spaceSmRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700' as const,
    color: theme.primaryTextColor
  },
  row: {
    padding: theme.rem(theme.spaceMdRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    gap: theme.rem(theme.spaceXsRem)
  },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600' as const,
    color: theme.primaryTextColor
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  problem: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.dangerColor
  },
  actions: {
    flexDirection: 'row' as const,
    gap: theme.rem(theme.spaceSmRem),
    marginTop: theme.rem(theme.spaceXsRem)
  },
  action: {
    flexGrow: 1,
    alignItems: 'center' as const,
    paddingVertical: theme.rem(theme.spaceSmRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor
  },
  actionLabel: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.linkTextColor
  },
  destructive: { color: theme.dangerColor },
  pressed: { opacity: 0.6 }
}))

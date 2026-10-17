import React, { useEffect, useRef, useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { CancelAction } from './CancelAction'

export interface ConfirmedAction {
  title: string
  detail: string
  sheetLabel?: string
  dismissLabel?: string
  fallback?: string
  testID?: string
  label: string
  accessibilityLabel?: string
  run: (current: () => boolean) => Promise<void>
}
/** One owner/visit, one confirmed write; obsolete responses cannot affect a new visit. */
export function useConfirmedAction(
  owner: unknown,
  identity: string
): {
  open: (action: ConfirmedAction) => void
  busy: boolean
  sheet: React.ReactNode
} {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [action, setAction] = useState<
    ConfirmedAction & { visit: { owner: unknown; identity: string } }
  >()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const lock = useRef(false)
  const generation = useRef(0)
  const alive = useRef(true)
  const visit = useRef({ owner, identity })
  // Invalidate during render, before an old promise can complete between commit/effect.
  if (visit.current.owner !== owner || visit.current.identity !== identity) {
    visit.current = { owner, identity }
    generation.current++
    lock.current = false
  }
  useEffect(() => {
    setAction(undefined)
    setBusy(false)
    setError('')
  }, [owner, identity])
  useEffect(() => {
    alive.current = true
    const requests = generation
    return () => {
      alive.current = false
      requests.current++
    }
  }, [])
  const close = (): void => {
    if (lock.current) return
    generation.current++
    setAction(undefined)
    setError('')
  }
  const confirm = async (): Promise<void> => {
    if (lock.current || action?.visit !== visit.current) return
    lock.current = true
    const token = ++generation.current
    const current = (): boolean => alive.current && generation.current === token
    setBusy(true)
    setError('')
    try {
      await action.run(current)
      if (current()) setAction(undefined)
    } catch (caught) {
      if (current())
        setError(
          caught instanceof Error
            ? caught.message
            : (action.fallback ?? 'The change could not be saved. Try again.')
        )
    } finally {
      if (current()) {
        lock.current = false
        setBusy(false)
      }
    }
  }
  return {
    busy,
    open: next => {
      if (lock.current) return
      generation.current++
      setError('')
      setAction({ ...next, visit: visit.current })
    },
    sheet:
      action?.visit !== visit.current ? null : (
        <Modal visible transparent animationType="slide" onRequestClose={close}>
          <View style={styles.scrim}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={action.dismissLabel ?? 'Cancel confirmation'}
              disabled={busy}
              style={styles.behind}
              onPress={close}
            />
            <View
              style={styles.sheet}
              accessibilityLabel={action.sheetLabel ?? 'Confirm change'}
            >
              <Text style={styles.title}>{action.title}</Text>
              <Text style={styles.detail}>{action.detail}</Text>
              {error !== '' && (
                <Text accessibilityRole="alert" style={styles.error}>
                  {error}
                </Text>
              )}
              <Button
                testID={action.testID}
                label={action.label}
                accessibilityLabel={action.accessibilityLabel}
                color={theme.dangerColor}
                busy={busy}
                onPress={() => {
                  confirm().catch(() => undefined)
                }}
              />
              <CancelAction
                destructivePrimary
                label="Cancel"
                disabled={busy}
                onPress={close}
              />
            </View>
          </View>
        </Modal>
      )
  }
}
const getStyles = cacheStyles((theme: Theme) => ({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(36),
    alignSelf: 'center',
    backgroundColor: theme.cardBackgroundColor,
    padding: theme.rem(1.25),
    paddingBottom: theme.rem(2),
    gap: theme.rem(0.75),
    borderTopLeftRadius: theme.rem(1),
    borderTopRightRadius: theme.rem(1)
  },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125)
  },
  detail: {
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.875),
    lineHeight: theme.rem(1.35)
  },
  error: { color: theme.dangerColor }
}))

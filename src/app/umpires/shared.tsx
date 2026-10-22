import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** Invalidates both reads and mutations when a screen changes identity. */
export function useUmpireWork(identity: string): {
  error: string
  busy: boolean
  run: (work: () => Promise<void>, concurrent?: boolean) => void
  live: () => boolean
} {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = useRef(identity)
  const mounted = useRef(true)
  active.current = identity
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const live = useCallback(
    () => mounted.current && active.current === identity,
    [identity]
  )
  const held = useRef(false)
  const pending = useRef(0)
  const run = useCallback(
    (work: () => Promise<void>, concurrent = false): void => {
      if (held.current && !concurrent) return
      if (!concurrent) held.current = true
      pending.current++
      setBusy(true)
      setError('')
      work()
        .catch((e: unknown) => {
          if (live())
            setError(e instanceof Error ? e.message : 'Please try again.')
        })
        .finally(() => {
          if (!concurrent) held.current = false
          pending.current--
          if (live() && pending.current === 0) setBusy(false)
        })
    },
    [live]
  )
  return { error, busy, run, live }
}
export function UmpireError({
  error
}: {
  error: string
}): React.ReactElement | null {
  const s = useUmpireStyles()
  return error === '' ? null : (
    <Text accessibilityRole="alert" style={s.error}>
      {error}
    </Text>
  )
}
export function UmpireHeading({
  children
}: {
  children: React.ReactNode
}): React.ReactElement {
  const s = useUmpireStyles()
  return (
    <Text accessibilityRole="header" style={s.title}>
      {children}
    </Text>
  )
}
export function UmpireCell({
  children,
  width = 140,
  gray = false,
  compact = false,
  divided = false
}: {
  children: React.ReactNode
  width?: number
  gray?: boolean
  compact?: boolean
  divided?: boolean
}): React.ReactElement {
  const s = useUmpireStyles()
  return (
    <View
      style={[
        s.cell,
        compact && s.compactCell,
        divided && s.dividedCell,
        { width },
        gray && { backgroundColor: '#EEEEEE', alignSelf: 'stretch' }
      ]}
    >
      {typeof children === 'string' ? (
        <Text style={compact ? s.tableText : s.text}>{children}</Text>
      ) : (
        children
      )}
    </View>
  )
}
export const useUmpireStyles = (): ReturnType<typeof getStyles> =>
  getStyles(useTheme())
const getStyles = cacheStyles((t: Theme) => ({
  page: { gap: t.rem(1), paddingVertical: t.rem(1) },
  title: {
    fontFamily: t.boldTextFont,
    fontSize: t.rem(1.5),
    color: t.primaryTextColor
  },
  text: {
    fontFamily: t.regularTextFont,
    fontSize: t.rem(1),
    color: t.primaryTextColor
  },
  hint: {
    fontFamily: t.regularTextFont,
    fontSize: t.rem(0.85),
    color: t.secondaryTextColor
  },
  tableText: {
    fontFamily: t.regularTextFont,
    fontSize: t.rem(0.75),
    color: t.primaryTextColor
  },
  tableHint: {
    fontFamily: t.regularTextFont,
    fontSize: t.rem(0.6375),
    color: t.secondaryTextColor
  },
  tableHeading: { fontFamily: t.boldTextFont, fontWeight: '700' },
  dividedCell: {
    borderRightWidth: 1,
    borderRightColor: t.glassBorderColor,
    alignSelf: 'stretch'
  },
  compactCell: {
    paddingHorizontal: t.rem(0.375),
    paddingVertical: 0,
    minHeight: 42
  },
  error: { color: t.dangerColor, fontSize: t.rem(1) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: t.rem(0.5),
    flexWrap: 'wrap'
  },
  remove: {
    color: t.dangerColor,
    fontFamily: t.regularTextFont,
    fontSize: t.rem(0.875)
  },
  check: { minHeight: 48, padding: t.rem(0.5), justifyContent: 'center' },
  cell: { padding: t.rem(0.5), minHeight: 56, justifyContent: 'center' },
  tableRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: t.glassBorderColor
  },
  circle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 2,
    borderColor: '#9E9E9E',
    alignItems: 'center',
    justifyContent: 'center'
  },
  green: { backgroundColor: '#2E7D32', borderColor: '#2E7D32' }
}))

import React, { useEffect, useRef, useState } from 'react'
import {
  type NativeSyntheticEvent,
  Platform,
  type PlatformOSType,
  Text,
  type TextInput,
  View
} from 'react-native'

import type { TeamStationClient } from '../../common/api'
import {
  DEFAULT_UMPIRE_NOTIFICATIONS,
  UMPIRE_NOTICE_DAYS,
  type UmpireNotificationSettings
} from '../../common/umpires'
import { Button, ListCard, ListRow, Screen } from '../components'
import { GridNumberCell, selectAll } from '../components/GridNumberCell'
import { PickerDialog } from '../components/PickerDialog'
import { settingRowStyles } from '../components/settings/settingRowStyles'
import { SettingToggleRow } from '../components/settings/SettingToggleRow'
import { useTitleHandoff } from '../components/useTitleHandoff'
import { Wheel } from '../components/Wheel'
import { lstrings, sprintf } from '../locales/strings'
import { useNotificationAsk } from '../push/notificationAskContext'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

type Input = React.ComponentRef<typeof TextInput>
type Toggle = 'missingSlots' | 'signUps' | 'withdrawals'

/** Every day the digest's window may be, 1 to 30. */
export const NOTICE_DAYS = Array.from(
  { length: UMPIRE_NOTICE_DAYS.max - UMPIRE_NOTICE_DAYS.min + 1 },
  (unused, i) => UMPIRE_NOTICE_DAYS.min + i
)

/** Whether typed text is a window the digest may have. */
export function noticeDays(text: string): number | undefined {
  const value = Number(text)
  return text !== '' &&
    Number.isInteger(value) &&
    value >= UMPIRE_NOTICE_DAYS.min &&
    value <= UMPIRE_NOTICE_DAYS.max
    ? value
    : undefined
}

/**
 * The league admin's own Umpire Management Notifications for one league:
 * missing slots, with the days before a game they start, sign-ups and
 * withdrawals. Each change is saved at once. Turning one on asks for this
 * device's notifications, which League management pushes come through.
 * Days is edited in place on the web and on a wheel in the app.
 */
export function UmpireNotificationsScreen({
  client,
  league,
  os = Platform.OS
}: {
  client: TeamStationClient
  league: string
  os?: PlatformOSType
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const rows = settingRowStyles(theme)
  const handoff = useTitleHandoff(lstrings.umpire_notifications_title)
  const ask = useNotificationAsk()
  const [settings, setSettings] = useState<UmpireNotificationSettings>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  useEffect(() => {
    client.umpireNotifications(league).then(
      value => {
        if (live.current) setSettings(value)
      },
      (caught: unknown) => {
        if (live.current) setError(failure(caught))
      }
    )
  }, [client, league])
  const shown = settings ?? DEFAULT_UMPIRE_NOTIFICATIONS
  /** Saves one change, shown at once and replaced by the server's answer. */
  const save = async (
    change: Partial<UmpireNotificationSettings>
  ): Promise<boolean> => {
    const before = shown
    setSettings({ ...before, ...change })
    setSaving(true)
    setError('')
    try {
      const answer = await client.setUmpireNotifications(league, change)
      if (live.current) setSettings(answer)
      return true
    } catch (caught) {
      if (live.current) {
        setSettings(before)
        setError(failure(caught))
      }
      return false
    } finally {
      if (live.current) setSaving(false)
    }
  }
  const toggle = (key: Toggle, label: string): React.ReactElement => (
    <SettingToggleRow
      label={label}
      testID={`umpire-notifications-${key}`}
      value={shown[key]}
      disabled={settings == null || saving}
      onChange={on => {
        save({ [key]: on })
          .then(saved => {
            if (saved && on) ask('leagueManagement')
          })
          .catch(() => undefined)
      }}
    />
  )
  const daysOff = settings == null || saving || !shown.missingSlots
  return (
    <Screen onScroll={handoff.handleScroll}>
      <View style={styles.page}>
        <View ref={handoff.ref} collapsable={false}>
          <Text style={styles.title} accessibilityRole="header">
            {lstrings.umpire_notifications_title}
          </Text>
        </View>
        <ListCard>
          {toggle('missingSlots', lstrings.umpire_notifications_missing_slots)}
          {os === 'web' ? (
            <DaysCell
              value={shown.daysBefore}
              disabled={daysOff}
              rowStyles={rows}
              cellStyle={styles.cell}
              cellText={styles.cellText}
              onSave={async daysBefore => await save({ daysBefore })}
            />
          ) : (
            <DaysWheel
              value={shown.daysBefore}
              disabled={daysOff}
              gated={rows.gated}
              onSave={daysBefore => {
                save({ daysBefore }).catch(() => undefined)
              }}
            />
          )}
          {toggle('signUps', lstrings.umpire_notifications_sign_ups)}
          {toggle('withdrawals', lstrings.umpire_notifications_withdrawals)}
        </ListCard>
        {error !== '' && (
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
        )}
      </View>
    </Screen>
  )
}

const failure = (caught: unknown): string =>
  caught instanceof Error && caught.message !== ''
    ? caught.message
    : lstrings.umpire_notifications_cannot_save

/**
 * The web's Days: the number, which a tap turns into a text field. Enter or
 * leaving the field saves it; a number outside 1 to 30 is refused, said, and
 * left in the field to change.
 */
function DaysCell({
  value,
  disabled,
  rowStyles,
  cellStyle,
  cellText,
  onSave
}: {
  value: number
  disabled: boolean
  rowStyles: ReturnType<typeof settingRowStyles>
  cellStyle: React.ComponentProps<typeof GridNumberCell>['style']
  cellText: React.ComponentProps<typeof GridNumberCell>['textStyle']
  onSave: (value: number) => Promise<boolean>
}): React.ReactElement {
  const [text, setText] = useState<string>()
  const [refusal, setRefusal] = useState('')
  const input = useRef<Input>(null)
  const held = useRef<string | undefined>(undefined)
  const busy = useRef(false)
  const edit = (next: string | undefined): void => {
    held.current = next
    setText(next)
  }
  const finish = (): void => {
    const typed = held.current
    if (typed == null || busy.current) return
    const days = noticeDays(typed)
    if (days == null) {
      setRefusal(lstrings.umpire_notifications_days_range)
      selectAll(input.current, typed.length)
      return
    }
    setRefusal('')
    edit(undefined)
    if (days === value) return
    busy.current = true
    onSave(days)
      .finally(() => {
        busy.current = false
      })
      .catch(() => undefined)
  }
  return (
    <View
      testID="umpire-notifications-days"
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      style={disabled && rowStyles.gated}
    >
      <View style={rowStyles.row}>
        <View style={rowStyles.text}>
          <Text style={rowStyles.title}>
            {lstrings.umpire_notifications_days}
          </Text>
          {refusal !== '' && (
            <Text accessibilityRole="alert" style={rowStyles.subtitle}>
              {refusal}
            </Text>
          )}
        </View>
        <GridNumberCell
          label={lstrings.umpire_notifications_days}
          testID="grid-cell-umpire-notifications-days"
          value={value}
          style={cellStyle}
          textStyle={cellText}
          disabled={disabled}
          onOpen={() => {
            edit(String(value))
          }}
          editing={
            text == null
              ? undefined
              : {
                  ref: input,
                  value: text,
                  autoFocus: true,
                  selectTextOnFocus: true,
                  maxLength: 2,
                  inputMode: 'numeric',
                  onChangeText: typed => {
                    edit(typed.replace(/\D/g, ''))
                    setRefusal('')
                  },
                  onBlur: finish,
                  onKeyPress: (event: NativeSyntheticEvent<unknown>) => {
                    const key = (event.nativeEvent as { key: string }).key
                    if (key === 'Enter') {
                      event.preventDefault()
                      finish()
                    } else if (key === 'Escape') {
                      event.preventDefault()
                      setRefusal('')
                      edit(undefined)
                    }
                  }
                }
          }
        />
      </View>
    </View>
  )
}

/**
 * The app's Days: the row shows the number, and a tap opens a wheel of 1 to
 * 30 whose Done saves the day turned to.
 */
function DaysWheel({
  value,
  disabled,
  gated,
  onSave
}: {
  value: number
  disabled: boolean
  gated: ReturnType<typeof settingRowStyles>['gated']
  onSave: (value: number) => void
}): React.ReactElement {
  const [turned, setTurned] = useState<number>()
  const close = (): void => {
    setTurned(undefined)
  }
  return (
    <View
      accessibilityState={{ disabled }}
      aria-disabled={disabled}
      style={disabled && gated}
    >
      <ListRow
        title={lstrings.umpire_notifications_days}
        titleNumberOfLines={0}
        trailing={String(value)}
        testID="umpire-notifications-days"
        accessibilityLabel={sprintf(
          lstrings.umpire_notifications_days_named,
          value
        )}
        disabled={disabled}
        onPress={() => {
          setTurned(value)
        }}
      />
      {turned != null && (
        <PickerDialog onClose={close}>
          <Wheel
            label={lstrings.umpire_notifications_days}
            options={NOTICE_DAYS}
            value={turned}
            testID="umpire-notifications-days-wheel"
            width={120}
            onChange={setTurned}
          />
          <Button
            label={lstrings.umpire_notifications_days_done}
            onPress={() => {
              close()
              if (turned !== value) onSave(turned)
            }}
          />
        </PickerDialog>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: { gap: theme.rem(1.25) },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5)
  },
  cell: {
    minWidth: theme.rem(3),
    minHeight: theme.rem(2.25),
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    borderRadius: theme.rem(0.375),
    borderWidth: 1,
    borderColor: theme.inputBorderColor
  },
  cellText: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    textAlign: 'center' as const
  },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.regularTextFont
  }
}))

import React, { useState } from 'react'
import { Text, View } from 'react-native'

import {
  DEFAULT_PLAYER_NAME_PRIVACY,
  DEFAULT_PRIVACY_LABEL,
  PLAYER_NAME_PRIVACY_LABELS,
  PLAYER_NAME_PRIVACY_STOPS,
  type PlayerNamePrivacy
} from '../../common/playerNamePrivacy'
import type { GroupDetail } from '../../common/publicGroups'
import { Button } from '../components/Button'
import { CancelAction } from '../components/CancelAction'
import { ListRow } from '../components/ListRow'
import { PickerDialog } from '../components/PickerDialog'
import { Wheel } from '../components/Wheel'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

const TITLE = 'Player Name Privacy'
/** Wide enough for `First initial, last initial`. */
const WHEEL_WIDTH = 240

/** What an unset level inherits, in words: the second line under Default. */
function inheritedLine(detail: GroupDetail): string {
  const label = PLAYER_NAME_PRIVACY_LABELS[detail.playerNamePrivacyFormat]
  const from = detail.playerNamePrivacyInheritedFrom
  return from.length === 0
    ? PLAYER_NAME_PRIVACY_LABELS[DEFAULT_PLAYER_NAME_PRIVACY]
    : `${label}, inherited from ${from.map(({ name }) => name).join(' and ')}`
}

/** The row's words: the stored value, and what Default currently means. */
export function privacyRowText(detail: GroupDetail): {
  subtitle: string
  detail?: string
} {
  const stored = detail.playerNamePrivacy
  return stored == null
    ? { subtitle: DEFAULT_PRIVACY_LABEL, detail: inheritedLine(detail) }
    : { subtitle: PLAYER_NAME_PRIVACY_LABELS[stored] }
}

const labelOf = (stop: number): string => {
  const value = PLAYER_NAME_PRIVACY_STOPS[stop]
  return value == null
    ? DEFAULT_PRIVACY_LABEL
    : PLAYER_NAME_PRIVACY_LABELS[value]
}

/**
 * How the public reads a level's player names. The stored value, or Default
 * and what that currently comes to, with a wheel to change it: only on the
 * form an administrator sees.
 */
export function PlayerNamePrivacyRow(props: {
  detail: GroupDetail
  disabled?: boolean
  onChoose: (value: PlayerNamePrivacy | null) => void
}): React.ReactElement {
  const { detail, disabled = false, onChoose } = props
  const styles = getStyles(useTheme())
  const [stop, setStop] = useState<number>()
  const text = privacyRowText(detail)
  const opening = (): void => {
    setStop(PLAYER_NAME_PRIVACY_STOPS.indexOf(detail.playerNamePrivacy))
  }
  return (
    <>
      <ListRow
        title={TITLE}
        subtitle={text.subtitle}
        // Two tied seasons can run long: this line wraps rather than cuts.
        detailContent={
          text.detail == null ? undefined : (
            <Text style={styles.detail}>{text.detail}</Text>
          )
        }
        accessibilityLabel={[TITLE, text.subtitle, text.detail]
          .filter(line => line != null)
          .join(', ')}
        onPress={disabled ? undefined : opening}
      />
      {stop != null && (
        <PickerDialog
          onClose={() => {
            setStop(undefined)
          }}
        >
          <View style={styles.picker}>
            <Text accessibilityRole="header" style={styles.title}>
              {TITLE}
            </Text>
            <Wheel
              label="Show players as"
              options={PLAYER_NAME_PRIVACY_STOPS.map((_, index) => index)}
              value={stop}
              onChange={setStop}
              format={labelOf}
              testID="player-name-privacy"
              width={WHEEL_WIDTH}
            />
            <Button
              label="Use"
              onPress={() => {
                setStop(undefined)
                onChoose(PLAYER_NAME_PRIVACY_STOPS[stop] ?? null)
              }}
            />
            <CancelAction
              onPress={() => {
                setStop(undefined)
              }}
            />
          </View>
        </PickerDialog>
      )}
    </>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  detail: { color: theme.secondaryTextColor, fontSize: theme.rem(0.875) },
  picker: { gap: theme.rem(0.75), alignItems: 'stretch' as const },
  title: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(1.125),
    fontFamily: theme.semiBoldTextFont
  }
}))

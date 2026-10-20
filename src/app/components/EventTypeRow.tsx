import React from 'react'
import { Text, View } from 'react-native'

import type { EventType } from '../../common/eventInfo'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { EventRsvpPill } from './EventRsvpPill'

const TYPES = ['game', 'practice', 'other'] as const
const RESPONSES = ['yes', 'maybe', 'no'] as const

export function EventTypeRow({
  value,
  onChange,
  disabled = false,
  gameAvailable = true
}: {
  value: EventType
  onChange: (type: EventType) => void
  disabled?: boolean
  gameAvailable?: boolean
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <View style={styles.row}>
      <Text testID="event-type-label" style={styles.label}>
        Event Type
      </Text>
      <View style={{ marginLeft: 'auto', maxWidth: '100%', flexShrink: 1 }}>
        <EventRsvpPill
          widthRem={16.5}
          labelSizeRem={0.75}
          value={RESPONSES[TYPES.indexOf(value)]}
          name="Event Type"
          groupLabel="Event Type"
          labels={['Game', 'Practice', 'Other']}
          testID="event-type"
          selectedColor={theme.pillActiveBackground}
          disabled={disabled}
          disabledChoices={gameAvailable ? [] : [0]}
          onChange={response => {
            onChange(TYPES[RESPONSES.indexOf(response)])
          }}
        />
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.rem(0.5)
  },
  label: {
    flex: 1,
    minWidth: theme.rem(3),
    fontFamily: theme.semiBoldTextFont,
    color: theme.primaryTextColor,
    fontSize: theme.rem(0.875)
  }
}))

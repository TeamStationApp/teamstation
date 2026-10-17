import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { CardDivider } from './Card'
import { Icon } from './Icon'
import { ListCard } from './ListCard'

/** A relationship's identity and its independent right-hand action. */
export function ActionRow({
  title,
  detail,
  leading,
  end,
  onOpen,
  openLabel,
  extra
}: {
  title: string
  detail?: string
  leading?: React.ReactNode
  end?: React.ReactNode
  onOpen?: () => void
  openLabel?: string
  extra?: React.ReactNode
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const identity = (
    <>
      {leading}
      <View style={styles.words}>
        <Text style={styles.name}>{title}</Text>
        {detail != null && detail !== '' && (
          <Text style={styles.detail}>{detail}</Text>
        )}
      </View>
      {onOpen != null && <Icon name="chevron_right" />}
    </>
  )
  return (
    <View style={styles.row} testID="relationship-action-row">
      <View style={styles.left}>
        {onOpen == null ? (
          <View style={styles.identity}>{identity}</View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={openLabel ?? `Open ${title}`}
            onPress={onOpen}
            style={styles.identity}
          >
            {identity}
          </Pressable>
        )}
        {extra}
      </View>
      {end}
    </View>
  )
}

/** Long lists have no bounding card; a short settings list can share one. */
export function ActionList({
  children,
  bounded = false,
  testID
}: {
  children: React.ReactNode
  bounded?: boolean
  testID?: string
}): React.ReactElement {
  if (bounded) return <ListCard testID={testID}>{children}</ListCard>
  return (
    <View testID={testID}>
      {React.Children.toArray(children).map((child, index) => (
        <React.Fragment key={React.isValidElement(child) ? child.key : index}>
          {index > 0 && <CardDivider />}
          {child}
        </React.Fragment>
      ))}
    </View>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.5),
    padding: theme.rem(theme.cardContentInsetRem),
    minHeight: 64
  },
  left: { flex: 1, minWidth: 0 },
  identity: {
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.75),
    minHeight: 48
  },
  words: { flex: 1, minWidth: 0, gap: theme.rem(0.25) },
  name: {
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '600',
    fontSize: theme.rem(1.0625),
    color: theme.primaryTextColor
  },
  detail: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  }
}))

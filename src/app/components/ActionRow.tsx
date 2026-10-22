import React from 'react'
import { Pressable, Text, View } from 'react-native'

import {
  cacheStyles,
  ScopedThemeProvider,
  type Theme,
  useTheme
} from '../theme/ThemeContext'
import { tsBallpark } from '../theme/tsBallpark'
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
  extra,
  separateEndAction = false
}: {
  title: string
  detail?: string
  leading?: React.ReactNode
  end?: React.ReactNode
  onOpen?: () => void
  openLabel?: string
  separateEndAction?: boolean
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
      {onOpen != null && !separateEndAction && <Icon name="chevron_right" />}
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
      {separateEndAction && end != null ? (
        <View style={styles.endAction}>
          <View
            testID="relationship-action-divider"
            style={styles.endDivider}
          />
          {end}
        </View>
      ) : (
        end
      )}
    </View>
  )
}

const cardThemes = new WeakMap<Theme, Theme>()

/** Some themes use a light card surface with light canvas text. */
function cardThemeOf(theme: Theme): Theme {
  if (theme.primaryTextColor !== theme.cardBackgroundColor) return theme
  let cardTheme = cardThemes.get(theme)
  if (cardTheme == null) {
    cardTheme = {
      ...theme,
      primaryTextColor: theme.secondaryTextColor,
      activeColor: theme.secondaryTextColor,
      containerBackgroundColor: theme.clearButtonColor,
      dangerColor: tsBallpark.dangerColor
    }
    cardThemes.set(theme, cardTheme)
  }
  return cardTheme
}

/** A bounded list's rows share one card; an unbounded list has none. */
export function ActionList({
  children,
  bounded = false,
  testID
}: {
  children: React.ReactNode
  bounded?: boolean
  testID?: string
}): React.ReactElement {
  const theme = useTheme()
  if (bounded)
    return (
      <ScopedThemeProvider theme={cardThemeOf(theme)}>
        <ListCard testID={testID}>{children}</ListCard>
      </ScopedThemeProvider>
    )
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
  endAction: {
    alignSelf: 'stretch',
    justifyContent: 'center',
    paddingLeft: theme.rem(0.75),
    marginVertical: -theme.rem(theme.cardContentInsetRem)
  },
  endDivider: {
    position: 'absolute',
    left: 0,
    top: '10%',
    bottom: '10%',
    width: 1,
    backgroundColor: theme.defaultBorderColor
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

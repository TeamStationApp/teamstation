import React from 'react'
import { Pressable, Text, View } from 'react-native'

import {
  cacheStyles,
  ScopedThemeProvider,
  type Theme,
  useTheme
} from '../theme/ThemeContext'
import { ButtonIcon } from './ButtonIcon'
import { CardDivider } from './Card'
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
  /** A second line of actions in the title's column, outside the open target. */
  extra?: React.ReactNode
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const words = (
    <>
      <Text style={styles.name}>{title}</Text>
      {detail != null && detail !== '' && (
        <Text style={styles.detail}>{detail}</Text>
      )}
    </>
  )
  const chevron = onOpen != null && !separateEndAction && (
    <ButtonIcon name="chevron_right" />
  )
  return (
    <View style={styles.row} testID="relationship-action-row">
      <View style={styles.left}>
        {extra != null ? (
          // A second line of its own actions sits in the title's column, as a
          // detail would. The open target lies under the whole identity, so
          // those actions are never nested inside it.
          <View style={styles.identity}>
            {onOpen != null && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={openLabel ?? `Open ${title}`}
                onPress={onOpen}
                style={styles.underlay}
              />
            )}
            <View pointerEvents="none">{leading}</View>
            <View style={styles.words} pointerEvents="box-none">
              <View pointerEvents="none" style={styles.wordsTop}>
                {words}
              </View>
              {extra}
            </View>
            <View pointerEvents="none">{chevron}</View>
          </View>
        ) : onOpen == null ? (
          <View style={styles.identity}>
            {leading}
            <View style={styles.words}>{words}</View>
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={openLabel ?? `Open ${title}`}
            onPress={onOpen}
            style={styles.identity}
          >
            {leading}
            <View style={styles.words}>{words}</View>
            {chevron}
          </Pressable>
        )}
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

const sameColor = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Some themes use a light card surface with light canvas text. Their card
 * tokens (`cardDangerColor`, `cardSuccessColor`, `cardDetailColor`), and their
 * `secondaryTextColor`, `tertiaryTextColor` and `clearButtonColor`, must read
 * on that light card.
 */
function cardThemeOf(theme: Theme): Theme {
  if (!sameColor(theme.primaryTextColor, theme.cardBackgroundColor))
    return theme
  let cardTheme = cardThemes.get(theme)
  if (cardTheme == null) {
    cardTheme = {
      ...theme,
      // A light surface: its own dark variants, and links set apart from titles.
      isDark: false,
      primaryTextColor: theme.secondaryTextColor,
      secondaryTextColor: theme.cardDetailColor,
      activeColor: theme.tertiaryTextColor,
      textButtonPressedColor: theme.clearButtonColor,
      dangerColor: theme.cardDangerColor,
      successColor: theme.cardSuccessColor
    }
    cardThemes.set(theme, cardTheme)
  }
  return cardTheme
}

/** A shared card's contents, in colours that read on the card. */
export function CardThemeScope({
  children
}: {
  children: React.ReactNode
}): React.ReactElement {
  return (
    <ScopedThemeProvider theme={cardThemeOf(useTheme())}>
      {children}
    </ScopedThemeProvider>
  )
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
  if (bounded)
    return (
      <CardThemeScope>
        <ListCard testID={testID}>{children}</ListCard>
      </CardThemeScope>
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
  wordsTop: { gap: theme.rem(0.25) },
  underlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0
  },
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

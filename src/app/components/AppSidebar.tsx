import React, { useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { NAV_TABS, type NavTabId } from './AppNav'
import { BuildInfoModal } from './BuildInfoModal'
import { ButtonIcon } from './ButtonIcon'
import { SIDEBAR_WIDTH_REM } from './sidebarLayout'
import { TsMark } from './TsMark'

export interface AppSidebarProps {
  selected: NavTabId
  onSelect: (tab: NavTabId) => void
  unread?: boolean
  apiBaseUrl?: string
  buildsClient?: TeamStationClient
  isAdmin?: boolean
  tess?: { onPress: () => void; open: boolean }
}

/** Labelled destinations beside the page, with Tess anchored below the list. */
export function AppSidebar(props: AppSidebarProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const [about, setAbout] = useState(false)
  const row = (
    label: string,
    icon: React.ReactElement,
    onPress: () => void,
    selected = false,
    tab = false,
    unread = false
  ): React.ReactElement => (
    <Pressable
      accessibilityRole={tab ? 'tab' : 'button'}
      accessibilityLabel={label}
      accessibilityState={tab ? { selected } : undefined}
      aria-selected={tab ? selected : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        selected && styles.selected,
        pressed && styles.pressed
      ]}
    >
      <View style={styles.icon}>{icon}</View>
      <Text style={styles.label}>{label}</Text>
      {unread && <View testID="chat-unread" style={styles.dot} />}
    </Pressable>
  )
  return (
    <View
      testID="navigation-sidebar"
      style={[
        styles.sidebar,
        { paddingTop: insets.top, paddingBottom: insets.bottom }
      ]}
    >
      <ScrollView
        style={styles.destinations}
        contentContainerStyle={styles.rows}
      >
        {row(
          lstrings.about_title,
          <ButtonIcon>
            <TsMark size={1.5} />
          </ButtonIcon>,
          () => {
            setAbout(true)
          }
        )}
        <View accessibilityRole="tablist">
          {NAV_TABS.map(tab => (
            <React.Fragment key={tab.id}>
              {row(
                tab.id === 'chat' ? 'Messages' : tab.label,
                <ButtonIcon name={tab.icon} color={theme.navActiveColor} />,
                () => {
                  props.onSelect(tab.id)
                },
                props.selected === tab.id,
                true,
                tab.id === 'chat' && props.unread === true
              )}
            </React.Fragment>
          ))}
        </View>
      </ScrollView>
      {props.tess != null && (
        <View style={styles.rows}>
          {row(
            lstrings.tess_ask,
            <ButtonIcon name="auto_awesome" color={theme.navActiveColor} />,
            props.tess.onPress,
            props.tess.open
          )}
        </View>
      )}
      {about && (
        <BuildInfoModal
          client={props.buildsClient}
          apiBaseUrl={props.apiBaseUrl}
          isAdmin={props.isAdmin}
          onClose={() => {
            setAbout(false)
          }}
        />
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  sidebar: {
    width: theme.rem(SIDEBAR_WIDTH_REM),
    flexShrink: 0,
    backgroundColor: theme.backgroundColor,
    borderRightWidth: 1,
    borderRightColor: theme.glassBorderColor
  },
  destinations: { flex: 1 },
  rows: { padding: theme.rem(0.5) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(0.5),
    paddingVertical: theme.rem(0.5),
    gap: theme.rem(0.75),
    borderRadius: theme.rem(0.5)
  },
  selected: { backgroundColor: theme.containerBackgroundColor },
  pressed: { opacity: 0.6 },
  icon: { width: theme.rem(1.75), alignItems: 'center' },
  label: {
    flex: 1,
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  },
  dot: {
    width: theme.rem(0.5),
    height: theme.rem(0.5),
    borderRadius: theme.rem(0.25),
    backgroundColor: theme.liveColor
  }
}))

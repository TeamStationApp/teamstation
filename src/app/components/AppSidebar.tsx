import React, { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { lstrings, sprintf } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { AppHeaderProps } from './AppHeader'
import { NAV_TABS, type NavTabId } from './AppNav'
import { BuildInfoModal } from './BuildInfoModal'
import { ButtonIcon } from './ButtonIcon'
import { PersonEmblem } from './PersonEmblem'
import { SIDEBAR_WIDTH_REM } from './sidebarLayout'
import { TsMark } from './TsMark'

export interface AppSidebarProps {
  selected: NavTabId
  onSelect: (tab: NavTabId) => void
  unread?: boolean
  apiBaseUrl?: string
  buildsClient?: TeamStationClient
  isAdmin?: boolean
  account?: AppHeaderProps['account']
  notifications?: AppHeaderProps['notifications']
}

/** Labelled destinations beside the page, beneath the primary app header. */
export function AppSidebar(props: AppSidebarProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  const [about, setAbout] = useState(false)
  const handleAccountPress = props.account?.onPress
  const row = (
    label: string,
    icon: React.ReactElement,
    onPress: () => void,
    selected = false,
    tab = false,
    unread = false,
    dotTestId = 'chat-unread',
    accessibilityLabel = label
  ): React.ReactElement => (
    <Pressable
      accessibilityRole={tab ? 'tab' : 'button'}
      accessibilityLabel={accessibilityLabel}
      accessibilityState={tab ? { selected } : undefined}
      aria-selected={tab ? selected : undefined}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        selected && styles.selected,
        pressed && styles.pressed
      ]}
    >
      {selected && <View pointerEvents="none" style={styles.selectionTint} />}
      <View style={styles.icon}>{icon}</View>
      <Text style={styles.label}>{label}</Text>
      {unread && <View testID={dotTestId} style={styles.dot} />}
    </Pressable>
  )
  return (
    <View
      testID="navigation-sidebar"
      style={[styles.sidebar, { paddingBottom: insets.bottom }]}
    >
      <ScrollView
        style={styles.destinations}
        contentContainerStyle={styles.rows}
      >
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
        {row(
          lstrings.about_title,
          <ButtonIcon>
            <TsMark size={1.5} />
          </ButtonIcon>,
          () => {
            setAbout(true)
          }
        )}
      </ScrollView>
      <View testID="sidebar-account-footer" style={styles.rows}>
        {props.notifications != null &&
          row(
            lstrings.header_notifications,
            <ButtonIcon name="notifications" color={theme.navActiveColor} />,
            props.notifications.onPress,
            false,
            false,
            props.notifications.pending,
            'notification-pending-dot',
            props.notifications.pending
              ? lstrings.header_notifications_waiting
              : lstrings.header_notifications
          )}
        {props.account != null && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={sprintf(
              lstrings.header_account_label,
              props.account.name
            )}
            onPress={handleAccountPress}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <PersonEmblem
              userId={props.account.userId}
              name={props.account.name}
              uri={props.account.avatarUrl}
              size={1.75}
            />
            <Text style={styles.label} numberOfLines={1}>
              {props.account.name}
            </Text>
          </Pressable>
        )}
      </View>
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
    flex: 1,
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
  selectionTint: {
    ...StyleSheet.absoluteFill,
    borderRadius: theme.rem(0.5),
    backgroundColor: theme.navActiveColor,
    opacity: 0.15
  },
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

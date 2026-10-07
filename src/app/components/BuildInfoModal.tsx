import React, { useEffect, useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { type BuildInfo, buildInfo } from '../../common/distribution'
import { lstrings } from '../locales/strings'
import { openExternal } from '../platform/externalBrowser'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

export function BuildInfoModal({
  client,
  onClose,
  info = buildInfo
}: {
  client?: TeamStationClient
  onClose: () => void
  info?: BuildInfo
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let active = true
    setUrl(undefined)
    client
      ?.buildsLink()
      .then(value => {
        if (active) setUrl(value)
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [client])
  const rows = [
    [lstrings.about_version, info.version],
    [lstrings.about_number, info.buildNumber],
    [lstrings.about_branch, info.branch],
    [lstrings.about_commit, info.commit],
    [lstrings.about_time, info.builtAt]
  ]
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Pressable
          style={styles.behind}
          accessibilityRole="button"
          accessibilityLabel={lstrings.about_close}
          onPress={onClose}
        />
        <View style={styles.sheet} accessibilityViewIsModal>
          <Text accessibilityRole="header" style={styles.heading}>
            {info.app}
          </Text>
          {rows.map(([label, value]) => (
            <View key={label} style={styles.row}>
              <Text style={styles.label}>{label}</Text>
              <Text selectable style={styles.value}>
                {value}
              </Text>
            </View>
          ))}
          {url != null && (
            <Button
              label={lstrings.about_builds}
              onPress={() => {
                setFailed(false)
                openExternal(url).catch(() => {
                  setFailed(true)
                })
              }}
            />
          )}
          {failed && (
            <Text accessibilityRole="alert" style={styles.value}>
              {lstrings.about_open_failed}
            </Text>
          )}
          <Button
            label={lstrings.about_close}
            accessibilityLabel={lstrings.about_close_button}
            kind="text"
            onPress={onClose}
          />
        </View>
      </View>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: theme.rem(1),
    backgroundColor: theme.overlayBackgroundColor
  },
  behind: { position: 'absolute', top: 0, bottom: 0, left: 0, right: 0 },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(30),
    padding: theme.rem(1.5),
    gap: theme.rem(1),
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(theme.radiusRem)
  },
  heading: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5)
  },
  row: { gap: theme.rem(0.25) },
  label: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  },
  value: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1)
  }
}))

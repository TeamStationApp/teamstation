import React, { useEffect, useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { type BuildInfo, buildInfo } from '../../common/distribution'
import { lstrings } from '../locales/strings'
import { browserOrigin } from '../platform/browserOrigin'
import { openExternal } from '../platform/externalBrowser'
import { RenderErrorProbe } from '../sentry'
import { nativeCrash } from '../sentrySdk'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

export function BuildInfoModal({
  client,
  apiBaseUrl = client?.baseUrl,
  onClose,
  info = buildInfo,
  isAdmin = false,
  crash = nativeCrash
}: {
  client?: TeamStationClient
  apiBaseUrl?: string
  onClose: () => void
  info?: BuildInfo
  /** A site administrator also gets the buttons that prove crash reporting works. */
  isAdmin?: boolean
  /** Crashes the native app; absent on the web, which has none. */
  crash?: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [url, setUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  const [renderError, setRenderError] = useState(false)
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
    [lstrings.about_time, info.builtAt],
    [lstrings.about_server, serverOrigin(apiBaseUrl)]
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
          {isAdmin && (
            <>
              <Button
                label={lstrings.about_test_error}
                kind="text"
                onPress={sendTestError}
              />
              <Button
                label={lstrings.about_test_render_error}
                kind="text"
                onPress={() => {
                  setRenderError(true)
                }}
              />
              {crash != null && (
                <Button
                  label={lstrings.about_test_native_crash}
                  kind="text"
                  onPress={crash}
                />
              )}
            </>
          )}
          {renderError && <RenderErrorProbe />}
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

function serverOrigin(apiBaseUrl?: string): string {
  try {
    const origin = new URL(apiBaseUrl ?? '/api/v1', browserOrigin()).origin
    // React Native's URL implementation retains credentials in origin.
    return /^https?:\/\//.test(origin)
      ? origin.replace(/^(https?:\/\/)[^/]*@/, '$1')
      : '—'
  } catch {
    return '—'
  }
}

/**
 * Throws from a press, the way an unplanned bug would, so the app's global
 * handler reports it. Named, so the reported stack says where it came from.
 */
export function sendTestError(): never {
  throw new Error('Sentry test error')
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

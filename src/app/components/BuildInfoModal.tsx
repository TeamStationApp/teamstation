import React, { useEffect, useState } from 'react'
import { Pressable, Text, TextInput, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { type BuildInfo, buildInfo } from '../../common/distribution'
import { lstrings, sprintf } from '../locales/strings'
import { browserOrigin } from '../platform/browserOrigin'
import { openExternal } from '../platform/externalBrowser'
import { developServerControl } from '../platform/serverControl'
import type { ServerControl } from '../platform/serverControlType'
import { RenderErrorProbe } from '../sentry'
import { nativeCrash } from '../sentrySdk'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { Modal } from './Modal'

/** Where the IP geolocation credit links, as DB-IP's licence asks. */
const DB_IP_URL = 'https://db-ip.com'

export type { ServerControl }

export function BuildInfoModal({
  client,
  apiBaseUrl = client?.baseUrl,
  onClose,
  info = buildInfo,
  isAdmin = false,
  crash = nativeCrash,
  serverControl = developServerControl()
}: {
  client?: TeamStationClient
  apiBaseUrl?: string
  onClose: () => void
  info?: BuildInfo
  /** A site administrator also gets the buttons that prove crash reporting works. */
  isAdmin?: boolean
  /** Crashes the native app; absent on the web, which has none. */
  crash?: () => void
  /** Lets the server row be changed, for the next launch: a develop phone build's alone. */
  serverControl?: ServerControl
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [betaUrl, setBetaUrl] = useState<string>()
  const [storeUrl, setStoreUrl] = useState<string>()
  const [failed, setFailed] = useState(false)
  const [renderError, setRenderError] = useState(false)
  const server = serverOrigin(apiBaseUrl)
  const [editing, setEditing] = useState(false)
  const [host, setHost] = useState('')
  const [serverNote, setServerNote] = useState<string>()
  useEffect(() => {
    let active = true
    setBetaUrl(undefined)
    setStoreUrl(undefined)
    const load =
      client == null
        ? undefined
        : client.distributionLinks != null
          ? client.distributionLinks()
          : client.buildsLink().then(url => ({
              betaBuildsUrl: url,
              appStoreUrl: undefined
            }))
    load
      ?.then(value => {
        if (!active) return
        setBetaUrl(value.betaBuildsUrl)
        setStoreUrl(value.appStoreUrl)
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
    [lstrings.about_commit, info.commit.slice(0, 6)],
    [lstrings.about_time, localBuildTime(info.builtAt)]
  ]
  const saveServer = (): void => {
    const next = host.trim() === '' ? null : host.trim()
    serverControl?.(next).then(
      kept => {
        setEditing(false)
        setServerNote(
          kept == null
            ? lstrings.about_server_cleared
            : sprintf(lstrings.about_server_set, kept)
        )
      },
      (error: unknown) => {
        setServerNote(error instanceof Error ? error.message : String(error))
      }
    )
  }
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
          <View style={styles.row}>
            <Text style={styles.label}>{lstrings.about_server}</Text>
            {serverControl == null ? (
              <Text selectable style={styles.value}>
                {server}
              </Text>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="server-origin"
                accessibilityHint={lstrings.about_server_change}
                testID="server-origin"
                onPress={() => {
                  setHost(server.replace(/^https:\/\//, ''))
                  setEditing(true)
                  setServerNote(undefined)
                }}
              >
                <Text style={styles.link}>{server}</Text>
              </Pressable>
            )}
            {editing && (
              <>
                <TextInput
                  accessibilityLabel="server-origin-field"
                  testID="server-origin-field"
                  placeholder={lstrings.about_server_field}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  value={host}
                  onChangeText={setHost}
                  onSubmitEditing={saveServer}
                  style={styles.field}
                />
                <Button
                  label={lstrings.about_server_save}
                  accessibilityLabel="server-origin-save"
                  onPress={saveServer}
                />
              </>
            )}
            {serverNote != null && (
              <Text accessibilityRole="alert" style={styles.value}>
                {serverNote}
              </Text>
            )}
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>{lstrings.about_credits}</Text>
            {/* DB-IP's free database places a reader's searches near them;
                its CC BY 4.0 licence asks for this credit and link. */}
            <Pressable
              accessibilityRole="link"
              onPress={() => {
                openExternal(DB_IP_URL).catch(() => undefined)
              }}
            >
              <Text style={styles.link}>{lstrings.about_ip_credit}</Text>
            </Pressable>
          </View>
          {betaUrl != null && betaUrl !== '' && (
            <Button
              label={lstrings.about_builds}
              onPress={() => {
                setFailed(false)
                openExternal(betaUrl).catch(() => {
                  setFailed(true)
                })
              }}
            />
          )}
          {storeUrl != null && storeUrl !== '' && (
            <Button
              label={lstrings.about_app_store}
              kind="secondary"
              onPress={() => {
                setFailed(false)
                openExternal(storeUrl).catch(() => {
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

/**
 * When the build was made, in this device's own time and way of writing it.
 * Anything that isn't a date stays as it is, such as a build's `—`.
 */
export function localBuildTime(builtAt: string, timeZone?: string): string {
  const at = new Date(builtAt)
  if (Number.isNaN(at.getTime())) return builtAt
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    timeZone
  }).format(at)
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
  },
  link: {
    color: theme.linkTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1)
  },
  field: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    borderColor: theme.secondaryTextColor,
    borderWidth: 1,
    borderRadius: theme.rem(0.25),
    paddingHorizontal: theme.rem(0.5),
    paddingVertical: theme.rem(0.375)
  }
}))

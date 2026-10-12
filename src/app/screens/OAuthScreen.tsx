import React, { useEffect, useMemo, useState } from 'react'
import { Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { Approval } from '../../common/distribution'
import { Button } from '../components/Button'
import { lstrings, sprintf } from '../locales/strings'
import { approvalClient } from '../oauth/approvalClient'
import {
  nativeBrowser,
  openExternal,
  resumeBrowser
} from '../platform/externalBrowser'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function OAuthScreen({
  client,
  uid,
  handle,
  accountName,
  onLogin,
  onSwitchAccount
}: {
  client: TeamStationClient
  uid?: string
  handle?: string
  accountName?: string
  onLogin: () => void
  onSwitchAccount?: () => Promise<void>
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const browser = useMemo(
    () => (uid == null ? undefined : approvalClient(uid)),
    [uid]
  )
  const [info, setInfo] = useState<Approval>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const [done, setDone] = useState(false)
  const [appUrl, setAppUrl] = useState<string>()
  useEffect(() => {
    let active = true
    setInfo(undefined)
    setFailed(false)
    setDone(false)
    setWaiting(false)
    setAppUrl(undefined)
    if (handle != null && accountName == null) return
    const load =
      handle == null ? browser!.details() : client.oauthApproval(handle)
    load
      .then(async value => {
        if (!active) return
        setInfo(value)
        if (browser != null && value.decision != null) {
          if (value.decision === 'pending') setWaiting(true)
          else {
            const url = await browser.resume()
            if (active && url != null) await resumeBrowser(url)
          }
        }
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
    }
  }, [browser, client, handle, accountName])
  useEffect(() => {
    if (!waiting || browser == null) return
    let active = true
    let polling = false
    const until = Date.now() + 300000
    const timer = setInterval(() => {
      if (polling) return
      if (Date.now() >= until) {
        setWaiting(false)
        setFailed(true)
        return
      }
      polling = true
      browser
        .resume()
        .then(async url => {
          if (active && url != null) {
            setWaiting(false)
            await resumeBrowser(url)
          }
        })
        .catch(() => {
          if (active) {
            setWaiting(false)
            setFailed(true)
          }
        })
        .finally(() => {
          polling = false
        })
    }, 3000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [waiting, browser])
  const decide = async (approve: boolean): Promise<void> => {
    setBusy(true)
    try {
      if (handle != null) {
        await client.decideOAuth(handle, approve)
        setDone(true)
      } else await resumeBrowser(await browser!.decide(approve))
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }
  const returnToBrowser = async (): Promise<void> => {
    try {
      const url = new URL(info!.resumeUrl!)
      const api = new URL(client.baseUrl)
      if (
        url.origin !== api.origin ||
        !/^\/oauth\/approve\/[A-Za-z0-9_-]+$/.test(url.pathname)
      )
        throw new Error()
      await openExternal(url.href)
    } catch {
      setFailed(true)
    }
  }
  return (
    <View style={styles.page}>
      <View style={styles.card}>
        <Text accessibilityRole="header" style={styles.title}>
          {lstrings.oauth_title}
        </Text>
        {failed ? (
          <Text accessibilityRole="alert" style={styles.text}>
            {lstrings.oauth_failed}
          </Text>
        ) : done ? (
          <>
            <Text style={styles.text}>{lstrings.oauth_done}</Text>
            {info?.resumeUrl != null && (
              <Button
                label={lstrings.oauth_return}
                onPress={() => {
                  returnToBrowser().catch(() => undefined)
                }}
              />
            )}
          </>
        ) : (
          <>
            {info != null && (
              <>
                <Text style={styles.text}>
                  {sprintf(lstrings.oauth_request, info.clientName)}
                </Text>
                {accountName != null && (
                  <Text style={styles.text}>
                    {sprintf(lstrings.oauth_identity, accountName)}
                  </Text>
                )}
                {info.scopes.map(scope => (
                  <Text key={scope} style={styles.text}>
                    {scope === 'email'
                      ? lstrings.oauth_email
                      : scope === 'profile'
                        ? lstrings.oauth_profile
                        : lstrings.oauth_signin}
                  </Text>
                ))}
              </>
            )}
            {info != null && accountName != null && onSwitchAccount != null && (
              <Button
                label={lstrings.oauth_switch}
                kind="text"
                busy={busy}
                onPress={() => {
                  setBusy(true)
                  onSwitchAccount()
                    .catch(() => {
                      setFailed(true)
                    })
                    .finally(() => {
                      setBusy(false)
                    })
                }}
              />
            )}
            {accountName == null ? (
              <Button label={lstrings.oauth_login} onPress={onLogin} />
            ) : (
              info != null && (
                <Button
                  label={lstrings.oauth_approve}
                  busy={busy}
                  onPress={() => {
                    decide(true).catch(() => undefined)
                  }}
                />
              )
            )}
            {info != null && (
              <Button
                label={lstrings.oauth_deny}
                kind="secondary"
                busy={busy}
                onPress={() => {
                  decide(false).catch(() => undefined)
                }}
              />
            )}
            {browser != null && !nativeBrowser && info != null && (
              <Button
                label={lstrings.oauth_app}
                kind="text"
                disabled={waiting || appUrl != null}
                onPress={() => {
                  browser
                    .native()
                    .then(url => {
                      setAppUrl(url)
                    })
                    .catch(() => {
                      setFailed(true)
                    })
                }}
              />
            )}
            {appUrl != null && !waiting && (
              <Button
                label={lstrings.oauth_open_app}
                onPress={() => {
                  resumeBrowser(appUrl)
                    .then(() => {
                      setWaiting(true)
                    })
                    .catch(() => {
                      setFailed(true)
                    })
                }}
              />
            )}
            {waiting && (
              <Text accessibilityLiveRegion="polite" style={styles.text}>
                {lstrings.oauth_waiting}
              </Text>
            )}
          </>
        )}
      </View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  page: {
    flex: 1,
    padding: theme.rem(2),
    justifyContent: 'center',
    alignItems: 'center'
  },
  card: {
    width: '100%',
    maxWidth: theme.rem(30),
    gap: theme.rem(1),
    padding: theme.rem(theme.cardContentInsetRem),
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(theme.radiusRem)
  },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5)
  },
  text: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1)
  }
}))

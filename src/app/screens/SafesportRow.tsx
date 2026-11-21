import React, { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { Button, ListCard, SectionHeader } from '../components'
import { Modal } from '../components/Modal'
import { SettingToggleRow } from '../components/settings/SettingToggleRow'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * A league's SafeSport Local Affiliated Organization switch, for those the
 * league's manage page answers (site administrators and the league's own):
 * it says whether the league is one, and nothing is drawn for anybody else,
 * or while the page cannot be read. Turning it on asks first, since the DMs
 * it then closes stay closed; turning it off saves at once. A save that
 * fails puts the switch back and says so.
 */
export function SafesportRow({
  client,
  leagueId
}: {
  client: TeamStationClient
  leagueId: string
}): React.ReactElement | null {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [on, setOn] = useState<boolean | undefined>(undefined)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const shown = useRef(leagueId)
  shown.current = leagueId

  useEffect(() => {
    let live = true
    // Another league's row starts afresh: a save still out for the last one
    // lands nowhere (`shown`).
    setOn(undefined)
    setFailed(false)
    setBusy(false)
    setAsking(false)
    client.managePage('league', leagueId).then(
      page => {
        if (live && page.scope.safesportLao != null)
          setOn(page.scope.safesportLao)
      },
      () => undefined
    )
    return () => {
      live = false
    }
  }, [client, leagueId])

  if (on == null) return null

  const save = (lao: boolean): void => {
    const league = leagueId
    setAsking(false)
    setBusy(true)
    setFailed(false)
    setOn(lao)
    client.setSafesport(league, lao).then(
      saved => {
        if (shown.current !== league) return
        setBusy(false)
        setOn(saved)
      },
      () => {
        if (shown.current !== league) return
        setBusy(false)
        setOn(!lao)
        setFailed(true)
      }
    )
  }

  return (
    <View style={styles.section}>
      <SectionHeader title={lstrings.manage_safesport_title} />
      <ListCard>
        <SettingToggleRow
          testID="safesport-row"
          label={lstrings.manage_safesport_label}
          subtitle={lstrings.manage_safesport_detail}
          value={on}
          disabled={busy}
          onChange={lao => {
            if (lao) setAsking(true)
            else save(false)
          }}
        />
      </ListCard>
      {failed && (
        <Text accessibilityRole="alert" style={styles.error}>
          {lstrings.manage_safesport_failed}
        </Text>
      )}
      {asking && (
        <Modal
          visible
          transparent
          animationType="fade"
          onRequestClose={() => {
            setAsking(false)
          }}
        >
          <View style={styles.scrim}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lstrings.manage_safesport_confirm_cancel}
              style={styles.behind}
              onPress={() => {
                setAsking(false)
              }}
            />
            <View
              testID="safesport-confirm"
              accessibilityLabel={lstrings.manage_safesport_confirm_title}
              style={styles.sheet}
            >
              <Text style={styles.title}>
                {lstrings.manage_safesport_confirm_title}
              </Text>
              <Text style={styles.body}>
                {lstrings.manage_safesport_confirm_body}
              </Text>
              <Button
                testID="safesport-confirm-ok"
                label={lstrings.manage_safesport_confirm_ok}
                color={theme.dangerColor}
                textColor="#FFFFFF"
                onPress={() => {
                  save(true)
                }}
              />
              <Button
                testID="safesport-confirm-cancel"
                label={lstrings.manage_safesport_confirm_cancel}
                color={theme.linkTextColor}
                textColor="#FFFFFF"
                onPress={() => {
                  setAsking(false)
                }}
              />
            </View>
          </View>
        </Modal>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  section: { gap: theme.rem(0.5) },
  error: { color: theme.dangerColor, paddingHorizontal: theme.rem(1) },
  scrim: { flex: 1, justifyContent: 'center', padding: theme.rem(1) },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(28),
    alignSelf: 'center',
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(1),
    padding: theme.rem(1.25),
    gap: theme.rem(1)
  },
  title: {
    color: theme.primaryTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.25),
    textAlign: 'center'
  },
  body: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    lineHeight: theme.rem(1.4),
    textAlign: 'center'
  }
}))

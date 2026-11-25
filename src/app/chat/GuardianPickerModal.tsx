import React, { useEffect, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import type { DmProxies, TeamStationClient } from '../../common/api'
import { PersonEmblem } from '../components'
import { CancelAction } from '../components/CancelAction'
import { Modal } from '../components/Modal'
import { lstrings, sprintf } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { getChatStyles } from './chatStyles'

export interface GuardianPickerModalProps {
  client: Pick<TeamStationClient, 'dmProxies'>
  /** The player who cannot sign in. */
  userId: string
  /** Their name, until the server's answer names them. */
  name: string
  /** Message this person instead. */
  onChoose: (userId: string) => void
  onClose: () => void
}

/**
 * Whom to message for a player who cannot be messaged (no account, or under
 * 13, which the heading says): their guardians, or with
 * none the viewer can reach, their current coaches, as `GET /chat/dm-proxies`
 * lists them. Choosing one closes the sheet and messages them; Cancel closes
 * it and messages nobody.
 */
export function GuardianPickerModal(
  props: GuardianPickerModalProps
): React.ReactElement {
  const { client, userId, onChoose, onClose } = props
  const theme = useTheme()
  const shared = getChatStyles(theme)
  const [proxies, setProxies] = useState<DmProxies>()
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    client
      .dmProxies(userId)
      .then(found => {
        if (live) setProxies(found)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [client, userId])

  // The server's name for the player, or the caller's until it answers (or
  // when it names them with nothing).
  const name =
    proxies == null || proxies.player.shortName === ''
      ? props.name
      : proxies.player.shortName
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={shared.scrim}>
        <Pressable
          style={shared.behind}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={lstrings.chat_cancel}
        />
        <ScrollView
          style={shared.sheetScroll}
          contentContainerStyle={shared.sheet}
          testID="dm-proxy-picker"
        >
          <Text style={shared.title} accessibilityRole="header">
            {
              // Why they need somebody else only once the server says.
              proxies == null
                ? name
                : sprintf(
                    proxies.why === 'tooYoung'
                      ? lstrings.chat_proxy_too_young
                      : lstrings.chat_proxy_no_account,
                    name
                  )
            }
          </Text>
          {failed ? (
            <Text accessibilityRole="alert" style={shared.error}>
              {lstrings.chat_new_failed}
            </Text>
          ) : proxies == null ? (
            <Text style={shared.muted}>{lstrings.common_loading}</Text>
          ) : (
            <>
              <Text style={shared.muted}>
                {proxies.kind === 'guardians'
                  ? lstrings.chat_proxy_choose_guardian
                  : lstrings.chat_proxy_choose_coach}
              </Text>
              <View>
                {proxies.people.map(person => (
                  <Pressable
                    key={person.userId}
                    testID={`dm-proxy-${person.userId}`}
                    accessibilityRole="button"
                    accessibilityLabel={sprintf(
                      lstrings.chat_proxy_choose_person,
                      person.shortName
                    )}
                    onPress={() => {
                      onChoose(person.userId)
                    }}
                    style={shared.row}
                  >
                    <PersonEmblem
                      userId={person.userId}
                      name={person.shortName}
                      uri={person.avatarUrl}
                      size={2}
                    />
                    <View style={shared.rowText}>
                      <Text style={shared.name}>{person.shortName}</Text>
                      {person.affiliations !== '' && (
                        <Text style={shared.small}>{person.affiliations}</Text>
                      )}
                    </View>
                  </Pressable>
                ))}
              </View>
            </>
          )}
          <CancelAction
            label={lstrings.chat_cancel}
            onPress={onClose}
            testID="dm-proxy-cancel"
          />
        </ScrollView>
      </View>
    </Modal>
  )
}

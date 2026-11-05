import React, { useEffect, useRef, useState } from 'react'
import { Modal, Text } from 'react-native'

import type { ChatBlock, TeamStationClient } from '../../common/api'
import type { GameSocket } from '../../common/gameSocket'
import { Button, Screen } from '../components'
import { ActionList, ActionRow } from '../components/ActionRow'
import { TextWidthButton } from '../components/TextWidthButton'
import { lstrings, sprintf } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { ChatAvatar } from './ChatAvatar'
import { ChatBlockConfirmation } from './ChatBlockConfirmation'
import { memberIdentity } from './chatIdentityModel'
import { ChatOverlayHost } from './ChatOverlayHost'
import { getChatStyles } from './chatStyles'

/** Account access uses the signed-in API, without enrolling encryption keys. */
export function BlockedPeople(props: {
  client: Pick<TeamStationClient, 'chatBlocks' | 'setChatBlock'>
  socket?: Pick<GameSocket, 'onChat'>
  onClose: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getChatStyles(theme)
  const [blocks, setBlocks] = useState<ChatBlock[]>()
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const [selected, setSelected] = useState<ChatBlock>()
  const generation = useRef(0)
  const lifetime = useRef(0)
  useEffect(() => {
    lifetime.current += 1
    setBlocks(undefined)
    setFailed(false)
    const refresh = (): void => {
      const version = ++generation.current
      props.client
        .chatBlocks()
        .then(rows => {
          if (version !== generation.current) return
          setBlocks(rows)
          setFailed(false)
          setSelected(current =>
            rows.some(row => row.userId === current?.userId)
              ? current
              : undefined
          )
        })
        .catch(() => {
          if (version === generation.current) setFailed(true)
        })
    }
    refresh()
    const unsubscribe = props.socket?.onChat(event => {
      if (
        event.type === 'resync' ||
        (event.type === 'chatUser' && event.kind === 'blocks')
      )
        refresh()
    })
    return () => {
      lifetime.current += 1
      generation.current += 1
      unsubscribe?.()
    }
  }, [props.client, props.socket, retry])
  return (
    <Modal visible animationType="slide" onRequestClose={props.onClose}>
      <ChatOverlayHost>
        <Screen>
          <Text style={styles.title}>{lstrings.chat_blocked_people}</Text>
          {failed ? (
            <>
              <Text style={styles.error}>{lstrings.chat_cannot_load}</Text>
              <Button
                label={lstrings.common_retry}
                kind="text"
                onPress={() => {
                  setRetry(retry + 1)
                }}
              />
            </>
          ) : blocks == null ? (
            <Text style={styles.muted}>{lstrings.common_loading}</Text>
          ) : blocks.length === 0 ? (
            <Text style={styles.muted}>
              {lstrings.chat_blocked_people_empty}
            </Text>
          ) : (
            <ActionList bounded>
              {blocks.map(person => (
                <ActionRow
                  key={person.userId}
                  title={person.shortName}
                  leading={<ChatAvatar identity={memberIdentity(person)} />}
                  end={
                    <TextWidthButton
                      label={lstrings.chat_unblock}
                      accessibilityLabel={sprintf(
                        lstrings.chat_unblock_person,
                        person.shortName
                      )}
                      onPress={() => {
                        setSelected(person)
                      }}
                    />
                  }
                />
              ))}
            </ActionList>
          )}
          <Button
            label={lstrings.common_done}
            kind="text"
            onPress={props.onClose}
          />
          {selected != null && (
            <ChatBlockConfirmation
              key={selected.userId}
              name={selected.shortName}
              action="unblock"
              onClose={() => {
                setSelected(undefined)
              }}
              onConfirm={async () => {
                const owner = lifetime.current
                const version = ++generation.current
                const rows = await props.client.setChatBlock(
                  selected.userId,
                  false
                )
                if (owner !== lifetime.current) return
                if (version === generation.current) setBlocks(rows)
                else {
                  generation.current += 1
                  setRetry(value => value + 1)
                }
              }}
            />
          )}
        </Screen>
      </ChatOverlayHost>
    </Modal>
  )
}

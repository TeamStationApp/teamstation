import React, { useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'

import type { IncludedAdult, TeamStationClient } from '../../common/api'
import { Button, Icon, TextField } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { getChatStyles } from './chatStyles'

/** How long typing pauses before a search goes out. */
export const ADULT_SEARCH_PAUSE_MS = 250

export interface IncludeAdultSheetProps {
  client: Pick<TeamStationClient, 'includedAdults'>
  /** The covered players the server named in `adultRequired`. */
  playerIds: number[]
  busy?: boolean
  /** Start the conversation again with these adults in it as well. */
  onSubmit: (userIds: number[]) => void
  onClose: () => void
  pauseMs?: number
}

/**
 * SafeSport's MAAPP, where a league is bound by it: a conversation between
 * an adult and a player under 18 must hold another qualifying adult. The
 * sheet explains it, suggests the player's guardians, family and coaches,
 * replaces them with every match as a name is typed, and starts the
 * conversation again with whoever is picked. It never adds anyone itself.
 */
export function IncludeAdultSheet(
  props: IncludeAdultSheetProps
): React.ReactElement {
  const { client, playerIds, onSubmit, onClose } = props
  const pauseMs = props.pauseMs ?? ADULT_SEARCH_PAUSE_MS
  const theme = useTheme()
  const shared = getChatStyles(theme)
  const [query, setQuery] = useState('')
  const [adults, setAdults] = useState<IncludedAdult[] | undefined>(undefined)
  const [picked, setPicked] = useState<IncludedAdult[]>([])
  const [failed, setFailed] = useState(false)

  const asked = query.trim()
  useEffect(() => {
    let live = true
    const timer = setTimeout(
      () => {
        client
          .includedAdults(playerIds, asked)
          .then(found => {
            if (live) {
              setAdults(found)
              setFailed(false)
            }
          })
          .catch(() => {
            if (live) setFailed(true)
          })
      },
      asked === '' ? 0 : pauseMs
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [asked, client, pauseMs, playerIds])

  const isPicked = (adult: IncludedAdult): boolean =>
    picked.some(entry => entry.userId === adult.userId)
  const toggle = (adult: IncludedAdult): void => {
    setPicked(current =>
      isPicked(adult)
        ? current.filter(entry => entry.userId !== adult.userId)
        : [...current, adult]
    )
  }

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
          keyboardShouldPersistTaps="handled"
        >
          <Text style={shared.title}>{lstrings.chat_include_title}</Text>
          <Text style={shared.muted}>{lstrings.chat_include_detail}</Text>
          <TextField
            label={lstrings.chat_include_search}
            value={query}
            onChangeText={setQuery}
          />
          {picked.length > 0 && (
            <View style={shared.actions}>
              {picked.map(adult => (
                <Button
                  key={adult.userId}
                  label={adult.shortName}
                  accessibilityLabel={sprintf(
                    lstrings.chat_include_unpick,
                    adult.shortName
                  )}
                  kind="secondary"
                  compact
                  onPress={() => {
                    toggle(adult)
                  }}
                />
              ))}
            </View>
          )}
          <Text style={shared.sectionLabel}>
            {asked === ''
              ? lstrings.chat_include_suggestions
              : lstrings.chat_include_results}
          </Text>
          {failed ? (
            <Text style={shared.error}>{lstrings.chat_new_failed}</Text>
          ) : adults == null ? (
            <Text style={shared.muted}>{lstrings.common_loading}</Text>
          ) : adults.length === 0 ? (
            <Text style={shared.muted}>{lstrings.chat_include_none}</Text>
          ) : (
            <View accessibilityLabel={lstrings.chat_include_results}>
              {adults.map(adult => (
                <Pressable
                  key={adult.userId}
                  accessibilityRole="button"
                  accessibilityLabel={sprintf(
                    isPicked(adult)
                      ? lstrings.chat_include_unpick
                      : lstrings.chat_include_pick,
                    adult.shortName
                  )}
                  accessibilityState={{ selected: isPicked(adult) }}
                  onPress={() => {
                    toggle(adult)
                  }}
                  style={shared.row}
                >
                  <View style={shared.rowText}>
                    <Text style={shared.name}>{adult.shortName}</Text>
                    <Text style={shared.small}>{adult.label}</Text>
                  </View>
                  {isPicked(adult) && (
                    <Icon name="star" color={theme.activeColor} />
                  )}
                </Pressable>
              ))}
            </View>
          )}
          <View style={shared.actions}>
            <Button
              label={lstrings.chat_include_submit}
              kind="primary"
              busy={props.busy}
              disabled={picked.length === 0 || props.busy === true}
              onPress={() => {
                onSubmit(picked.map(adult => adult.userId))
              }}
            />
            <Button
              label={lstrings.chat_cancel}
              kind="text"
              onPress={onClose}
            />
          </View>
        </ScrollView>
      </View>
    </Modal>
  )
}

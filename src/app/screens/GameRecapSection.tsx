import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import type { GameDetail, TeamStationClient } from '../../common/api'
import {
  type GameRecap,
  type RecapClip,
  recapPlay
} from '../../common/gameRecap'
import { Screen } from '../components'
import {
  CardBand,
  PillBand,
  PinnedContent,
  PinnedSpacer
} from '../components/PinnedBands'
import type { PinnedHead } from '../components/pinnedHead'
import { useSceneShown } from '../components/sceneShown'
import { useScreenScope } from '../hooks/useScreenScope'
import { lstrings } from '../locales/strings'
import { attachHls } from '../player/attachHls'
import { seekTo } from '../player/explicitSeek'
import { livePlaybackRetryDelay } from '../player/liveRejoin'
import type { VideoHandle } from '../player/videoHandle'
import { VideoView } from '../player/VideoView'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

interface Props {
  client: TeamStationClient
  game: Pick<GameDetail, 'id' | 'nonMemberView'>
  pinned: PinnedHead
  head: React.ReactNode
  tabs: React.ReactNode
  membership: React.ReactNode
}

/** The player shares the pinned pill band; only the article scrolls beneath it. */
export function GameRecapSection({
  client,
  game,
  pinned,
  head,
  tabs,
  membership
}: Props): React.ReactElement {
  const styles = getStyles(useTheme())
  const shown = useSceneShown()
  const { height } = useWindowDimensions()
  const [recap, setRecap] = useState<GameRecap | null>(null)
  const [failed, setFailed] = useState(false)
  const [clip, setClip] = useState<RecapClip | null>(null)
  const member = !game.nonMemberView
  const generation = useRef(0)
  useEffect(() => {
    setRecap(null)
    setFailed(false)
    setClip(null)
    return () => {
      generation.current++
    }
  }, [game.id, member, shown])
  const load = useCallback(async (): Promise<void> => {
    if (!member || !shown) return
    const request = ++generation.current
    setFailed(false)
    try {
      const next = await client.gameRecap(game.id)
      if (request === generation.current) setRecap(next)
    } catch {
      if (request === generation.current) setFailed(true)
    }
  }, [client, game.id, member, shown])
  const read = useScreenScope(load, client)
  useEffect(() => {
    read().catch(() => undefined)
  }, [read])
  const doc = recap?.document
  return (
    <Screen {...pinned.screen} wide>
      <CardBand part={pinned.cardBand}>{head}</CardBand>
      <PillBand part={pinned.pillBand} testID="recapPinnedBand">
        {tabs}
        {member && clip != null && shown && (
          <View
            style={[
              styles.player,
              { maxHeight: height * 0.35, maxWidth: (height * 0.35 * 16) / 9 }
            ]}
            testID="recapPlayer"
          >
            <RecapPlayer client={client} clip={clip} />
          </View>
        )}
      </PillBand>
      <PinnedContent part={pinned.content} testID="recapArticle">
        <View style={styles.article}>
          {!member ? (
            membership
          ) : failed || recap?.status === 'failed' ? (
            <Text style={styles.body}>{lstrings.game_recap_failed}</Text>
          ) : recap == null || recap.status === 'pending' ? (
            <View accessibilityRole="progressbar">
              <ActivityIndicator />
              <Text style={styles.body}>{lstrings.game_recap_pending}</Text>
            </View>
          ) : doc == null ? (
            <Text style={styles.body}>{lstrings.game_recap_absent}</Text>
          ) : (
            <>
              <Text accessibilityRole="header" style={styles.headline}>
                {doc.headline}
              </Text>
              <Text style={styles.date}>{doc.dateLine}</Text>
              {doc.paragraphs.map((paragraph, index) => (
                <Text key={index} style={styles.paragraph}>
                  {paragraph.map((sentence, n) => {
                    const play = recapPlay(sentence)
                    const target =
                      play == null ? undefined : recap.clips[String(play)]
                    return (
                      <Text
                        key={n}
                        style={target == null ? styles.body : styles.link}
                        accessibilityRole={target == null ? undefined : 'link'}
                        accessibilityLabel={
                          target == null ? undefined : sentence.text
                        }
                        onPress={
                          target == null
                            ? undefined
                            : () => {
                                setClip({ ...target })
                              }
                        }
                      >
                        {sentence.text}
                        {n + 1 < paragraph.length ? ' ' : ''}
                      </Text>
                    )
                  })}
                </Text>
              ))}
            </>
          )}
        </View>
      </PinnedContent>
      <PinnedSpacer part={pinned.spacer} />
    </Screen>
  )
}

/** Normal authorized playback resource, with one selected sentence's bounds. */
export function RecapPlayer({
  client,
  clip
}: {
  client: TeamStationClient
  clip: RecapClip
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const [loaded, setLoaded] = useState<{ clip: RecapClip; url: string } | null>(
    null
  )
  const source = loaded?.clip === clip ? loaded.url : null
  const [failed, setFailed] = useState(false)
  const [player, setPlayer] = useState<VideoHandle | null>(null)
  useEffect(() => {
    let active = true
    let asks = 0
    let pending = false
    let timer: ReturnType<typeof setTimeout> | undefined
    setLoaded(null)
    setFailed(false)
    const retry = (): void => {
      const delay = livePlaybackRetryDelay(asks++)
      if (delay == null) setFailed(true)
      else timer = setTimeout(read, delay)
    }
    const read = (): void => {
      client
        .playback(clip.videoId)
        .then(value => {
          if (!active) return
          if (value.pending === true && value.url == null) {
            pending = true
            retry()
          } else if (value.url == null || value.unavailable) setFailed(true)
          else setLoaded({ clip, url: value.url })
        })
        .catch(() => {
          if (!active) return
          if (pending) retry()
          else setFailed(true)
        })
    }
    read()
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [client, clip])
  useEffect(() => {
    if (player == null || source == null) return
    let began = false
    let active = true
    let ended = false
    const start = (): void => {
      if (began || player.readyState < 1) return
      began = true
      seekTo(player, clip.start)
      player.play().catch(async (error: unknown) => {
        if (!active) return
        if (
          error instanceof Error &&
          error.name === 'NotAllowedError' &&
          !player.muted
        ) {
          player.muted = true
          try {
            await player.play()
          } catch {
            if (active) setFailed(true)
          }
        } else setFailed(true)
      })
    }
    const stop = (): void => {
      if (player.currentTime >= clip.end) {
        if (!player.paused) player.pause()
        if (!ended) {
          ended = true
          seekTo(player, clip.end)
        }
      } else ended = false
    }
    const error = (): void => {
      setFailed(true)
    }
    player.addEventListener('loadedmetadata', start)
    player.addEventListener('canplay', start)
    player.addEventListener('timeupdate', stop)
    player.addEventListener('error', error)
    const detach = attachHls(player, source, error, {
      wantsToPlay: () => !player.paused,
      onUnsupported: error
    })
    start()
    return () => {
      active = false
      player.removeEventListener('loadedmetadata', start)
      player.removeEventListener('canplay', start)
      player.removeEventListener('timeupdate', stop)
      player.removeEventListener('error', error)
      player.pause()
      detach()
    }
  }, [player, source, clip])
  return (
    <>
      <VideoView source={source} onHandle={setPlayer} controls primary />
      {failed ? (
        <Text style={styles.videoMessage}>
          {lstrings.game_video_unavailable}
        </Text>
      ) : source == null ? (
        <ActivityIndicator />
      ) : null}
    </>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  article: { padding: theme.rem(1), gap: theme.rem(0.75) },
  headline: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    color: theme.primaryTextColor
  },
  date: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  paragraph: {
    marginTop: theme.rem(0.75),
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    lineHeight: theme.rem(1.6),
    color: theme.primaryTextColor
  },
  body: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    lineHeight: theme.rem(1.6),
    color: theme.primaryTextColor
  },
  link: { color: theme.linkTextColor },
  player: {
    width: '100%',
    alignSelf: 'center',
    aspectRatio: 16 / 9,
    backgroundColor: '#000',
    marginTop: theme.rem(0.75)
  },
  videoMessage: { color: '#fff', padding: theme.rem(1) }
}))

import React, { useCallback, useEffect, useState } from 'react'
import { Image, Text, View } from 'react-native'

import type {
  PlayByPlay,
  PlayClip,
  PlayRow,
  PlayScoreLine
} from '../../common/api'
import { VideoPoster } from '../components/VideoPoster'
import { attachHls } from '../player/attachHls'
import { HAVE_METADATA, type VideoHandle } from '../player/videoHandle'
import { VideoView } from '../player/VideoView'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface PlaysTabProps {
  /** Undefined while the list is loading. */
  plays: PlayByPlay | undefined
  /** The video the clips seek into. Absent until playback is ready. */
  playbackUrl: string | null
  /** A press on a clip when this viewer may not play the video. */
  onLocked?: () => void
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds))
  const minutes = Math.floor(whole / 60)
  const rest = whole % 60
  return `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`
}

function initial(name: string | null): string {
  const trimmed = name?.trim() ?? ''
  return trimmed === '' ? '?' : trimmed.slice(0, 1).toUpperCase()
}

/**
 * One clip. It opens at the highlight rewind and pauses five seconds before
 * the next scoring play.
 */
function Clip(props: {
  clip: PlayClip
  playbackUrl: string | null
  onLocked?: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [handle, setHandle] = useState<VideoHandle | null>(null)
  const [playing, setPlaying] = useState(false)
  const takeHandle = useCallback((next: VideoHandle | null) => {
    setHandle(current => (current === next ? current : next))
  }, [])
  const length =
    props.clip.endOffsetSec == null
      ? null
      : props.clip.endOffsetSec - props.clip.startOffsetSec

  useEffect(() => {
    if (!playing || handle == null || props.playbackUrl == null) return
    const detach = attachHls(handle, props.playbackUrl, () => undefined)
    const element = handle
    const begin = (): void => {
      element.currentTime = props.clip.startOffsetSec
      element.play().catch(() => undefined)
    }
    if (element.readyState >= HAVE_METADATA) begin()
    else element.addEventListener('loadedmetadata', begin)
    const onTime = (): void => {
      const end = props.clip.endOffsetSec
      if (end != null && element.currentTime >= end) element.pause()
    }
    element.addEventListener('timeupdate', onTime)
    return () => {
      element.removeEventListener('loadedmetadata', begin)
      element.removeEventListener('timeupdate', onTime)
      detach()
    }
  }, [playing, handle, props.playbackUrl, props.clip])

  if (!playing) {
    return (
      <VideoPoster
        uri={props.clip.stillUrl}
        time={length == null ? undefined : clock(length)}
        showPlay
        size="hero"
        onPlay={() => {
          if (props.playbackUrl == null) props.onLocked?.()
          else setPlaying(true)
        }}
      />
    )
  }
  return (
    <View style={styles.clip}>
      <VideoView source={props.playbackUrl} controls onHandle={takeHandle} />
    </View>
  )
}

function Score(props: { score: PlayScoreLine }): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const awayBold = props.score.batting === 'away'
  return (
    <Text style={styles.score}>
      <Text style={awayBold ? styles.scoreStrong : undefined}>
        {props.score.awayLabel} {props.score.awayScore}
      </Text>
      {', '}
      <Text style={awayBold ? undefined : styles.scoreStrong}>
        {props.score.homeLabel} {props.score.homeScore}
      </Text>
    </Text>
  )
}

function Row(props: {
  play: PlayRow
  playbackUrl: string | null
  onLocked?: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const play = props.play
  return (
    <View style={styles.row}>
      {play.avatarUrl == null ? (
        <View style={styles.avatarFallback}>
          <Text style={styles.avatarLetter}>{initial(play.batterName)}</Text>
        </View>
      ) : (
        <Image source={{ uri: play.avatarUrl }} style={styles.avatar} />
      )}
      <View style={styles.copy}>
        <Text style={styles.pill}>{play.outcome}</Text>
        <Text style={styles.sentence}>
          {play.sentence}
          {play.outsLabel == null ? null : (
            <Text style={styles.outs}>{` ${play.outsLabel}`}</Text>
          )}
        </Text>
        {play.score == null ? null : <Score score={play.score} />}
        {play.clip == null ? null : (
          <Clip
            clip={play.clip}
            playbackUrl={props.playbackUrl}
            onLocked={props.onLocked}
          />
        )}
      </View>
    </View>
  )
}

/**
 * A finalized game, at-bat by at-bat. The shape follows a play-by-play list:
 * a half-inning heading, then each plate appearance, and a clip under a home
 * run, double, triple, or double play.
 */
export function PlaysTab(props: PlaysTabProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const plays = props.plays
  if (plays == null) {
    return <Text style={styles.waiting}>Loading plays…</Text>
  }
  return (
    <View testID="playsTab" style={styles.list}>
      {plays.prelude == null ? null : (
        <View style={styles.prelude}>
          <Text style={styles.preludeTitle}>First pitch</Text>
          <Text style={styles.preludeLine}>{plays.prelude.time}</Text>
          {plays.prelude.place == null ? null : (
            <Text style={styles.preludeLine}>{plays.prelude.place}</Text>
          )}
        </View>
      )}
      {plays.innings.map(inning => (
        <View key={inning.heading}>
          <Text style={styles.heading}>{inning.heading}</Text>
          {inning.plays.map(play => (
            <Row
              key={play.eventId}
              play={play}
              playbackUrl={props.playbackUrl}
              onLocked={props.onLocked}
            />
          ))}
        </View>
      ))}
      {plays.innings.length === 0 ? (
        <Text style={styles.waiting}>No plays recorded.</Text>
      ) : null}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  list: {
    paddingBottom: theme.rem(2)
  },
  waiting: {
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.9),
    paddingVertical: theme.rem(1)
  },
  prelude: {
    marginBottom: theme.rem(0.75)
  },
  preludeTitle: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(0.95),
    fontWeight: '600'
  },
  preludeLine: {
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.85)
  },
  heading: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(1.35),
    fontWeight: '700',
    marginTop: theme.rem(0.8),
    marginBottom: theme.rem(0.45)
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: theme.rem(0.9)
  },
  avatar: {
    width: theme.rem(2.4),
    height: theme.rem(2.4),
    borderRadius: theme.rem(1.2),
    marginRight: theme.rem(0.6)
  },
  avatarFallback: {
    width: theme.rem(2.4),
    height: theme.rem(2.4),
    borderRadius: theme.rem(1.2),
    marginRight: theme.rem(0.6),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.pillActiveBackground
  },
  avatarLetter: {
    color: theme.pillActiveTextColor,
    fontWeight: '700'
  },
  copy: {
    flex: 1
  },
  pill: {
    alignSelf: 'flex-start',
    color: theme.pillActiveTextColor,
    backgroundColor: theme.pillActiveBackground,
    overflow: 'hidden',
    borderRadius: theme.rem(0.7),
    paddingHorizontal: theme.rem(0.45),
    paddingVertical: theme.rem(0.1),
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    marginBottom: theme.rem(0.2)
  },
  sentence: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(0.95),
    lineHeight: theme.rem(1.25)
  },
  outs: {
    fontWeight: '700'
  },
  score: {
    color: theme.primaryTextColor,
    fontSize: theme.rem(0.95),
    marginTop: theme.rem(0.35)
  },
  scoreStrong: {
    fontWeight: '700'
  },
  clip: {
    marginTop: theme.rem(0.5),
    width: '100%',
    aspectRatio: 16 / 9,
    borderRadius: theme.rem(0.4),
    overflow: 'hidden',
    backgroundColor: '#000'
  }
}))

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Platform, StyleSheet } from 'react-native'
import Video, {
  BufferingStrategyType,
  type VideoRef,
  ViewType
} from 'react-native-video'

import { nativeSource } from './nativeSource'
import { NativeVideoHandle } from './nativeVideoHandle'
import type { VideoViewProps } from './videoViewProps'

export type { VideoViewProps }

/**
 * Four times a second, which is what a browser's `timeupdate` does.
 *
 * The number matters because the shared code was written against that rate:
 * the play description clears itself by counting played seconds, and a coarser
 * interval would leave it up too long.
 */
const PROGRESS_MS = 250

/**
 * The picture, on a phone.
 *
 * `react-native-video` rather than anything of our own: AVPlayer and ExoPlayer
 * both play HLS natively, both decode HEVC in hardware on the devices that
 * matter, and both bring a control bar that scrubs, mutes and goes fullscreen
 * the way the platform's own players do — which is the same bargain the web
 * app strikes with the browser's controls.
 *
 * Two decisions that are not obvious:
 *
 * **`ViewType.TEXTURE` on Android.** The default is a `SurfaceView`, which is
 * punched through the window rather than drawn in the view tree: it cannot be
 * clipped by the rounded corners and `overflow: 'hidden'` on `PlayerSurface`,
 * and nothing drawn above it composites — which is the nine invisible gesture
 * squares, the live pill and the `0.25×` badge, all of them. A `TextureView`
 * costs a little power and behaves like a view.
 *
 * **The handle outlives the player.** It is made once, on the first render,
 * and handed up; the `<Video>` beneath it is free to be handed a new source.
 * The shared code holds the handle in a ref across angle changes and would
 * lose its place if a new object arrived with each one.
 */
export function VideoViewNative(props: VideoViewProps): React.ReactElement {
  const {
    source,
    onHandle,
    controls = false,
    onControlsVisible,
    muted = false,
    resizeMode = 'contain',
    opacity = 1,
    buffer,
    live = false
  } = props

  // A counter, not the props object: the handle owns those and mutates them,
  // so the only thing to tell React is *that* they changed.
  const [, bump] = useState(0)
  const handleRef = useRef<NativeVideoHandle | null>(null)
  handleRef.current ??= new NativeVideoHandle(() => {
    bump(count => count + 1)
  })
  const handle = handleRef.current
  // Android ignores the same source handed to it twice (`clearBeforeReload`).
  handle.clearBeforeReload = Platform.OS === 'android'
  const playerRef = useRef<VideoRef | null>(null)

  const takePlayer = useCallback(
    (player: VideoRef | null): void => {
      playerRef.current = player
      handle.attach(player)
    },
    [handle]
  )

  // Handed up once, and taken back when this goes. `onHandle` is the same
  // callback the web file calls with the `<video>` element, so the screens
  // above cannot tell which platform they are on.
  useEffect(() => {
    onHandle(handle)
    return () => {
      onHandle(null)
    }
  }, [handle, onHandle])

  // Everything known about the old recording is wrong the moment the source
  // changes — its length, its shape, and where the playhead was.
  useEffect(() => {
    handle.source = source
    handle.reset()
  }, [handle, source])

  // Android takes its buffer with the source, so the source is built once per
  // address and per setting rather than on every render.
  // Whether this source was live when it was handed over, kept with it.
  const liveFor = useRef<{ source: string | null; live: boolean } | null>(null)
  if (liveFor.current?.source !== source) liveFor.current = { source, live }
  const liveSource = liveFor.current.live

  const aheadSec = buffer?.aheadSec
  const startSec = buffer?.startSec
  const behindSec = buffer?.behindSec
  const heapShare = buffer?.heapShare
  const videoSource = useMemo(
    () =>
      nativeSource(source ?? '', {
        live: liveSource,
        aheadSec,
        startSec,
        behindSec,
        heapShare
      }),
    [source, liveSource, aheadSec, startSec, behindSec, heapShare]
  )

  // A reload asks for exactly this again, settings and all.
  handle.sourceConfig = source == null || source === '' ? null : videoSource

  if (source == null || source === '') {
    return <></>
  }

  return (
    <Video
      ref={takePlayer}
      source={videoSource}
      style={[StyleSheet.absoluteFill, { opacity }]}
      resizeMode={resizeMode}
      controls={controls}
      onControlsVisibilityChange={event => {
        onControlsVisible?.(event.isVisible)
      }}
      paused={handle.props.paused}
      muted={muted || handle.props.muted}
      rate={handle.props.rate}
      progressUpdateInterval={PROGRESS_MS}
      // A card's silent preview must not take the audio session away from
      // whatever the person was already listening to.
      disableFocus={!controls}
      ignoreSilentSwitch={controls ? 'ignore' : 'obey'}
      // Pulling down Control Center or Notification Center only makes the app
      // inactive, and react-native-video pauses AVPlayer for that unless told
      // not to. It means to resume on the way back, but the pause has already
      // told it the player stopped, so it never does: a viewer who toggled
      // Wi-Fi to cellular in Control Center came back to a live game standing
      // still until they pressed play. Leaving the app still pauses it.
      playWhenInactive
      viewType={Platform.OS === 'android' ? ViewType.TEXTURE : undefined}
      onLoad={handle.handleLoad}
      onProgress={handle.handleProgress}
      onSeek={handle.handleSeek}
      onPlaybackStateChanged={handle.handlePlaybackState}
      onBuffer={handle.handleBuffer}
      bufferingStrategy={
        heapShare == null
          ? BufferingStrategyType.DEFAULT
          : BufferingStrategyType.DEPENDING_ON_MEMORY
      }
      // iOS's half of `buffer`; AVPlayer decides for itself when to start.
      preferredForwardBufferDuration={aheadSec}
      onReadyForDisplay={handle.handleReadyForDisplay}
      onVideoTracks={handle.handleVideoTracks}
      onAspectRatio={handle.handleAspectRatio}
      onEnd={handle.handleEnd}
      onError={handle.handleError}
    />
  )
}

export { VideoViewNative as VideoView }

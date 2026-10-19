/**
 * `react-native-video` for the player's native specs
 * (`scripts/build-player-native-tests.mjs`), which render `VideoView.native`
 * in a browser bundle: the real package resolves there to its web component,
 * which takes none of the props the phone players are given.
 *
 * `Video` draws a `<div data-video-props>` holding the props it was handed,
 * functions left out, so a spec reads what `VideoView.native` asked the
 * player for. Its ref answers the calls the handle makes and records them.
 */
import React, { forwardRef, useImperativeHandle } from 'react'

export enum BufferingStrategyType {
  DEFAULT = 'Default',
  DISABLE_BUFFERING = 'DisableBuffering',
  DEPENDING_ON_MEMORY = 'DependingOnMemory'
}

export enum ViewType {
  TEXTURE = 0,
  SURFACE = 1,
  SURFACE_SECURE = 2
}

export interface VideoRef {
  seek: (time: number, tolerance?: number) => void
  pause: () => void
  resume: () => void
  calls: Array<{ name: string; args: unknown[] }>
}

const Video = forwardRef<VideoRef, Record<string, unknown>>(
  function Video(props, ref) {
    const calls: VideoRef['calls'] = []
    useImperativeHandle(ref, () => ({
      calls,
      seek: (...args: unknown[]) => calls.push({ name: 'seek', args }),
      pause: () => calls.push({ name: 'pause', args: [] }),
      resume: () => calls.push({ name: 'resume', args: [] })
    }))
    const shown = Object.fromEntries(
      Object.entries(props).filter(
        ([key, value]) =>
          key !== 'children' && key !== 'style' && typeof value !== 'function'
      )
    )
    return (
      <div data-video-props={JSON.stringify(shown)}>
        {props.children as React.ReactNode}
      </div>
    )
  }
)

export default Video

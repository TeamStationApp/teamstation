import React, { useRef } from 'react'
import { View } from 'react-native'

import { Button } from '../components'
import type { SponsorSampleUploadProps } from './sponsorSampleUploadProps'

export type { PickedSample } from './sponsorSampleUploadProps'

/**
 * The node administrator's Upload for the sponsor sample video, on the web:
 * a button that opens the browser's chooser for an MP4. The server checks
 * the file; nothing is shrunk or changed here.
 */
export function SponsorSampleUpload({
  busy,
  disabled = false,
  onPick
}: SponsorSampleUploadProps): React.ReactElement {
  const input = useRef<HTMLInputElement>(null)
  return (
    <View>
      <Button
        label="Upload sample video"
        kind="secondary"
        busy={busy}
        disabled={disabled}
        onPress={() => {
          input.current?.click()
        }}
      />
      <input
        ref={input}
        type="file"
        accept="video/mp4,video/quicktime"
        aria-label="Sample video file"
        data-testid="sponsor-sample-input"
        style={{ display: 'none' }}
        onChange={event => {
          const target = event.currentTarget
          const file = target.files?.[0]
          target.value = ''
          if (file == null) return
          onPick({
            contentType: file.type === '' ? 'video/mp4' : file.type,
            size: file.size,
            bytes: async () => new Uint8Array(await file.arrayBuffer())
          })
        }}
      />
    </View>
  )
}

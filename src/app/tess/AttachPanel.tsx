import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'
import { base64 } from 'rfc4648'

import { Button } from '../components/Button'
import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { TessUpload } from './tessTypes'
import { checkUploadSize, TESS_ACCEPT, uploadTypeOf } from './tessUploads'

export interface AttachPanelProps {
  onAttach: (upload: TessUpload) => void
  onError: (message: string) => void
  onClose: () => void
}

/** A dropped or chosen file, checked and read for upload. */
export async function readWebFile(file: File): Promise<TessUpload> {
  const type = uploadTypeOf(file.name, file.type)
  if (type == null) throw new Error(lstrings.tess_attach_unsupported)
  checkUploadSize(file.name, type.kind, file.size)
  const data = base64.stringify(new Uint8Array(await file.arrayBuffer()))
  return { name: file.name, mediaType: type.mediaType, data }
}

/**
 * The browser's attach panel: a dashed zone to drop files on, and a button
 * that opens the system's chooser. Each file Tess can read is attached; any
 * other is refused with the reason.
 */
export function AttachPanel({
  onAttach,
  onError,
  onClose
}: AttachPanelProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const zone = useRef<React.ComponentRef<typeof View>>(null)
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const latest = useRef({ onAttach, onError, onClose })
  latest.current = { onAttach, onError, onClose }

  const take = (files: ArrayLike<File> | null): void => {
    const chosen = Array.from(files ?? [])
    if (chosen.length === 0) return
    latest.current.onClose()
    for (const file of chosen)
      readWebFile(file).then(
        upload => {
          latest.current.onAttach(upload)
        },
        (error: unknown) => {
          latest.current.onError(
            error instanceof Error
              ? error.message
              : lstrings.tess_attach_unreadable
          )
        }
      )
  }
  const takeRef = useRef(take)
  takeRef.current = take

  useEffect(() => {
    // react-native-web draws a View as a div, which takes the drag events
    // React Native has no props for.
    const node = zone.current as unknown as HTMLElement | null
    if (node == null) return
    const dragOver = (event: DragEvent): void => {
      event.preventDefault()
      setOver(true)
    }
    const dragLeave = (): void => {
      setOver(false)
    }
    const drop = (event: DragEvent): void => {
      event.preventDefault()
      setOver(false)
      takeRef.current(event.dataTransfer?.files ?? null)
    }
    node.addEventListener('dragover', dragOver)
    node.addEventListener('dragleave', dragLeave)
    node.addEventListener('drop', drop)
    return () => {
      node.removeEventListener('dragover', dragOver)
      node.removeEventListener('dragleave', dragLeave)
      node.removeEventListener('drop', drop)
    }
  }, [])

  return (
    <View testID="Tess attach panel" style={styles.panel}>
      <View
        ref={zone}
        testID="Tess drop zone"
        style={[styles.zone, over && styles.over]}
      >
        <Icon name="attach_file" color={theme.secondaryTextColor} />
        <Text style={styles.zoneText}>{lstrings.tess_drop_here}</Text>
      </View>
      <Button
        kind="secondary"
        label={lstrings.tess_choose_files}
        onPress={() => {
          input.current?.click()
        }}
      />
      <input
        ref={input}
        type="file"
        multiple
        accept={TESS_ACCEPT}
        aria-label={lstrings.tess_choose_files}
        style={{ display: 'none' }}
        onChange={event => {
          const target = event.currentTarget
          take(target.files)
          target.value = ''
        }}
      />
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  panel: {
    gap: theme.rem(theme.spaceSmRem),
    padding: theme.rem(theme.spaceSmRem),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.cardBackgroundColor
  },
  zone: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(theme.spaceXsRem),
    minHeight: theme.rem(6),
    borderRadius: theme.rem(theme.radiusRem),
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: theme.defaultBorderColor
  },
  over: {
    borderColor: theme.activeColor,
    backgroundColor: theme.highlightRowBackground
  },
  zoneText: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  }
}))

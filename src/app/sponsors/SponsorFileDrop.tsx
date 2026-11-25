import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import { Button } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { type ObjectUrls, pickedFileOf } from './pickedFiles'
import type { PickedFile } from './sponsorTypes'

export interface SponsorFileDropProps {
  /** What the zone is for, e.g. "Add Logo"; also its accessible name. */
  label: string
  /** The line in the zone, e.g. "Drop a PNG here or Choose file". */
  prompt: string
  /** The chooser's `accept`, e.g. "image/png". */
  accept: string
  onPick: (picked: PickedFile) => void
  /** The sentence under the zone, for a file that was refused. */
  error?: string | null
  testID?: string
  /** The browser's object URLs, which a test stands in for. */
  urls?: ObjectUrls
}

/** Whether a drag carries files, rather than text or a link. */
function carriesFiles(event: DragEvent): boolean {
  const data = event.dataTransfer
  if (data == null) return false
  return (
    Array.from(data.types ?? []).includes('Files') ||
    Array.from(data.items ?? []).some(item => item.kind === 'file') ||
    (data.files?.length ?? 0) > 0
  )
}

/**
 * A dashed zone a file can be dropped on, with a Choose file button that
 * opens the browser's chooser. Only file drags are taken, and the zone is
 * lit while one is over it. Either way the first file is handed on as a
 * `PickedFile`; the screen checks it.
 */
export function SponsorFileDrop({
  label,
  prompt,
  accept,
  onPick,
  error,
  testID = 'sponsor-drop-zone',
  urls
}: SponsorFileDropProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const zone = useRef<React.ComponentRef<typeof View>>(null)
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const take = useRef<(files: ArrayLike<File> | null | undefined) => void>(
    () => undefined
  )
  take.current = files => {
    const first = files?.[0]
    if (first != null) onPick(pickedFileOf(first, urls))
  }

  useEffect(() => {
    // react-native-web draws a View as a div, which takes the drag events
    // React Native has no props for.
    const node = zone.current as unknown as HTMLElement | null
    if (node == null) return
    let depth = 0
    const clear = (): void => {
      depth = 0
      setOver(false)
    }
    const enter = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      depth += 1
      setOver(true)
    }
    const dragOver = (event: DragEvent): void => {
      if (!carriesFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer != null) event.dataTransfer.dropEffect = 'copy'
      setOver(true)
    }
    const leave = (event: DragEvent): void => {
      depth = Math.max(0, depth - 1)
      if (
        event.relatedTarget instanceof Node &&
        node.contains(event.relatedTarget)
      )
        return
      if (depth === 0) clear()
    }
    const drop = (event: DragEvent): void => {
      clear()
      if (!carriesFiles(event)) return
      event.preventDefault()
      event.stopPropagation()
      take.current(event.dataTransfer?.files)
    }
    node.addEventListener('dragenter', enter)
    node.addEventListener('dragover', dragOver)
    node.addEventListener('dragleave', leave)
    node.addEventListener('drop', drop)
    window.addEventListener('dragend', clear)
    return () => {
      node.removeEventListener('dragenter', enter)
      node.removeEventListener('dragover', dragOver)
      node.removeEventListener('dragleave', leave)
      node.removeEventListener('drop', drop)
      window.removeEventListener('dragend', clear)
    }
  }, [])

  return (
    <View style={styles.wrap}>
      <View
        ref={zone}
        testID={testID}
        accessibilityLabel={label}
        dataSet={{ over: over ? 'true' : 'false' }}
        style={[styles.zone, over && styles.over]}
      >
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.prompt}>{prompt}</Text>
        <Button
          kind="secondary"
          label="Choose file"
          accessibilityLabel={`Choose file: ${label}`}
          onPress={() => {
            input.current?.click()
          }}
        />
        <input
          ref={input}
          type="file"
          accept={accept}
          aria-label={label}
          data-testid={`${testID}-input`}
          style={{ display: 'none' }}
          onChange={event => {
            const target = event.currentTarget
            take.current(target.files)
            target.value = ''
          }}
        />
      </View>
      {error != null && error !== '' && (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  wrap: { gap: theme.rem(0.5) },
  zone: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(0.5),
    minHeight: theme.rem(8),
    padding: theme.rem(1),
    borderRadius: theme.rem(0.75),
    borderWidth: 2,
    borderStyle: 'dashed',
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.cardBackgroundColor
  },
  over: {
    borderColor: theme.activeColor,
    backgroundColor: theme.highlightRowBackground
  },
  label: {
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  },
  prompt: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    textAlign: 'center'
  },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375)
  }
}))

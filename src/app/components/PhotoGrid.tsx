import React from 'react'
import { Image, Pressable, ScrollView, Text, View } from 'react-native'

import type { AvailablePicture } from '../../common/pictureCatalog'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface PhotoGridProps {
  entries: AvailablePicture[]
  selectedId?: string
  onSelect: (id: string) => void
  onUpload: () => void
}

export function PhotoGrid({
  entries,
  selectedId,
  onSelect,
  onUpload
}: PhotoGridProps): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <ScrollView style={styles.scroll} testID="sports-picture-grid">
      <View style={styles.grid}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add Photo"
          onPress={onUpload}
          style={styles.cell}
        >
          <View style={styles.upload}>
            <Text style={styles.plus}>+</Text>
            <Text style={styles.label}>Add Photo</Text>
          </View>
        </Pressable>
        {entries
          .filter(entry => entry.kind === 'photo')
          .map(entry => (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              accessibilityLabel={entry.label}
              accessibilityState={{ selected: selectedId === entry.id }}
              onPress={() => {
                onSelect(entry.id)
              }}
              style={styles.cell}
            >
              <View
                style={[
                  styles.picture,
                  selectedId === entry.id && styles.selected
                ]}
              >
                <Image
                  source={{ uri: entry.url }}
                  accessibilityLabel={entry.label}
                  style={styles.image}
                  resizeMode="contain"
                />
                {selectedId === entry.id && <Text style={styles.check}>✓</Text>}
              </View>
            </Pressable>
          ))}
      </View>
    </ScrollView>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scroll: { maxHeight: 390, width: '100%' as const },
  grid: { flexDirection: 'row' as const, flexWrap: 'wrap' as const },
  cell: { width: '33.333333%' as const, aspectRatio: 1, padding: 5 },
  picture: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: theme.cardBackgroundColor,
    padding: 8
  },
  selected: { borderColor: theme.primaryButtonColor },
  upload: {
    flex: 1,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: theme.defaultBorderColor,
    justifyContent: 'center' as const,
    alignItems: 'center' as const
  },
  plus: { color: theme.primaryTextColor, fontSize: 35 },
  label: { color: theme.primaryTextColor, fontSize: 14 },
  image: { width: '100%' as const, height: '100%' as const },
  check: {
    position: 'absolute' as const,
    top: 3,
    right: 5,
    color: theme.primaryTextColor,
    fontSize: 18
  }
}))

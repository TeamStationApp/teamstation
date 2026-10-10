import React, { useEffect, useState } from 'react'
import {
  Image,
  Linking,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  View
} from 'react-native'

import { GlassView } from '../components/GlassView'
import { Icon } from '../components/Icon'
import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { MODAL_ORIENTATIONS } from '../scoring/modalOrientations'
import { cacheStyles, type Theme } from '../theme/ThemeContext'
import { tsDark } from '../theme/tsDark'
import {
  appleMusicSettings1,
  appleMusicSettings2,
  type SettingsShot
} from './assets'

export interface AppleMusicSetupProps {
  visible: boolean
  /** Done, or the close button: the walkthrough has been seen. */
  onClose: () => void
  /** Music's page in Settings; `openMusicSettings` unless a test hands one in. */
  openSettings?: () => void
}

/** The four Apple Music settings, in the order Settings lists them. */
const SETTINGS = (): string[] => [
  lstrings.walkup_setup_add_playlist,
  lstrings.walkup_setup_sync,
  lstrings.walkup_setup_cellular,
  lstrings.walkup_setup_auto
]

/**
 * The Apple Music settings that keep walk-up songs on this iPhone, in three
 * full-screen pages: what to turn on, then each pair of settings as it looks
 * in Settings, boxed in red, with Go to Settings.
 *
 * It is dark whatever the app's theme. Patina's provider cannot give one
 * subtree a theme of its own, so every colour here comes from `tsDark`
 * directly, the buttons are its own, and the glass is told it is dark.
 * Go to Settings opens Music's page in the Settings app, and each page names
 * the path for when it cannot.
 */
export function AppleMusicSetup(
  props: AppleMusicSetupProps
): React.ReactElement {
  const { visible, onClose, openSettings = openMusicSettings } = props
  const styles = getStyles(tsDark)
  const insets = useInsets()
  const [page, setPage] = useState(0)
  // Back to the first page as it closes, so the next opening slides in on
  // page 1 rather than jumping there from where it was left.
  useEffect(() => {
    if (!visible) setPage(0)
  }, [visible])

  const settingsButton = (
    <DarkButton
      label={lstrings.walkup_setup_settings}
      onPress={() => {
        // Not the press event: `openMusicSettings` takes a Linking.
        openSettings()
      }}
      styles={styles}
    />
  )

  return (
    <Modal
      supportedOrientations={MODAL_ORIENTATIONS}
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
    >
      {/* The light app's status bar is dark text: on this dark page it
          would vanish, so the page takes light text while it shows. */}
      {visible && <StatusBar barStyle="light-content" animated />}
      <View
        style={[
          styles.screen,
          { paddingTop: insets.top, paddingBottom: insets.bottom }
        ]}
        testID="apple-music-setup"
      >
        <View style={styles.top}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={lstrings.walkup_setup_close}
            onPress={onClose}
            style={styles.closeTouch}
          >
            <GlassView dark radius={tsDark.rem(1.375)} style={styles.close}>
              <Icon name="close" size={1.25} color={tsDark.primaryTextColor} />
            </GlassView>
          </Pressable>
        </View>
        <ScrollView
          style={styles.body}
          contentContainerStyle={styles.bodyContent}
        >
          {page === 0 ? (
            <>
              <View style={styles.noteCircle}>
                <Icon
                  name="music_note"
                  size={3}
                  color={tsDark.buttonTextColor}
                />
              </View>
              <View style={styles.spacer} />
              <Text style={styles.intro}>{lstrings.walkup_setup_intro}</Text>
              <View style={styles.list}>
                {SETTINGS().map(name => (
                  <View key={name} style={styles.listRow}>
                    <View style={styles.bullet} />
                    <Text style={styles.listText}>{name}</Text>
                  </View>
                ))}
              </View>
            </>
          ) : (
            <>
              <Shot
                shot={page === 1 ? appleMusicSettings1 : appleMusicSettings2}
                label={
                  page === 1
                    ? `${lstrings.walkup_setup_add_playlist}, ${lstrings.walkup_setup_sync}`
                    : `${lstrings.walkup_setup_cellular}, ${lstrings.walkup_setup_auto}`
                }
                styles={styles}
              />
              <Text style={styles.path}>{lstrings.walkup_setup_path}</Text>
              {page === 2 && (
                <Text style={styles.note}>{lstrings.walkup_setup_note}</Text>
              )}
            </>
          )}
        </ScrollView>
        <View style={styles.bottom}>
          {page === 0 ? (
            <>
              <View style={styles.flex} />
              <DarkButton
                label={lstrings.walkup_setup_next}
                onPress={() => {
                  setPage(1)
                }}
                styles={styles}
              />
            </>
          ) : page === 1 ? (
            <>
              <View style={styles.flex} />
              {settingsButton}
              <DarkButton
                label={lstrings.walkup_setup_next}
                trailing="chevron_right"
                onPress={() => {
                  setPage(2)
                }}
                styles={styles}
              />
            </>
          ) : (
            <>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={lstrings.walkup_setup_back}
                onPress={() => {
                  setPage(1)
                }}
                style={styles.back}
              >
                <Icon
                  name="chevron_left"
                  size={1.25}
                  color={tsDark.primaryTextColor}
                />
                <Text style={styles.backText}>
                  {lstrings.walkup_setup_back}
                </Text>
              </Pressable>
              <View style={styles.flex} />
              {settingsButton}
              <DarkButton
                label={lstrings.walkup_setup_done}
                onPress={onClose}
                styles={styles}
              />
            </>
          )}
        </View>
      </View>
    </Modal>
  )
}

/** The part of `Linking` that opens Settings. */
export type SettingsLinking = Pick<typeof Linking, 'openURL' | 'openSettings'>

/**
 * Settings › Apps › Music. iOS has no public address for another app's
 * settings: `App-prefs:` with Music's bundle id is Settings' own, which
 * Apple does not document and may change. If iOS refuses it, TeamStation's
 * page in Settings opens instead, and the walkthrough's caption gives the
 * rest of the way.
 */
export function openMusicSettings(linking: SettingsLinking = Linking): void {
  linking
    .openURL(MUSIC_SETTINGS_URL)
    .catch(async () => {
      await linking.openSettings()
    })
    .catch(() => undefined)
}

const MUSIC_SETTINGS_URL = 'App-prefs:com.apple.Music'

/** A filled button in the dark theme's colours, whatever the app's. */
function DarkButton(props: {
  label: string
  trailing?: 'chevron_right'
  onPress: () => void
  styles: ReturnType<typeof getStyles>
}): React.ReactElement {
  const { label, trailing, onPress, styles } = props
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
    >
      <Text style={styles.buttonLabel}>{label}</Text>
      {trailing != null && (
        <Icon name={trailing} size={1.1} color={tsDark.buttonTextColor} />
      )}
    </Pressable>
  )
}

/** A screenshot of Settings, at its own shape, as wide as the page. */
function Shot(props: {
  shot: SettingsShot | null
  label: string
  styles: ReturnType<typeof getStyles>
}): React.ReactElement | null {
  const { shot, label, styles } = props
  // Measured, not "100%": an image takes its own width from its asset, and
  // a 3x screenshot of a whole screen's width overruns the page's margins.
  const [width, setWidth] = useState(0)
  if (shot == null) return null
  return (
    <View
      style={styles.shotFrame}
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
    >
      {width > 0 && (
        <Image
          accessibilityLabel={label}
          source={shot.source}
          resizeMode="contain"
          style={[styles.shot, { width, height: width / shot.aspectRatio }]}
        />
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.backgroundColor
  },
  top: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingTop: theme.rem(theme.spaceSmRem)
  },
  closeTouch: {
    width: theme.rem(2.75),
    height: theme.rem(2.75)
  },
  close: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.rem(1.375)
  },
  body: {
    flex: 1
  },
  bodyContent: {
    flexGrow: 1,
    alignItems: 'stretch',
    paddingHorizontal: theme.rem(theme.spaceLgRem),
    paddingVertical: theme.rem(theme.spaceMdRem),
    gap: theme.rem(theme.spaceMdRem)
  },
  noteCircle: {
    alignSelf: 'center',
    width: theme.rem(7),
    height: theme.rem(7),
    marginTop: theme.rem(2),
    borderRadius: theme.rem(3.5),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.primaryButtonColor
  },
  spacer: {
    flexGrow: 1
  },
  intro: {
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '600',
    fontSize: theme.rem(1.125),
    lineHeight: theme.rem(1.6),
    color: theme.primaryTextColor
  },
  list: {
    gap: theme.rem(theme.spaceSmRem)
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.75)
  },
  bullet: {
    width: theme.rem(0.5),
    height: theme.rem(0.5),
    borderRadius: theme.rem(0.25),
    backgroundColor: theme.primaryButtonColor
  },
  listText: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1.0625),
    color: theme.primaryTextColor
  },
  shotFrame: {
    alignSelf: 'stretch'
  },
  shot: {
    borderRadius: theme.rem(0.75)
  },
  path: {
    alignSelf: 'center',
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '600',
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  // The dark theme's secondary text is its background colour, so the note
  // is the primary text, a little quieter.
  note: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    lineHeight: theme.rem(1.35),
    color: theme.primaryTextColor,
    opacity: 0.8
  },
  bottom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceMdRem)
  },
  flex: {
    flex: 1
  },
  back: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: theme.rem(2.75)
  },
  backText: {
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '600',
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.25),
    minHeight: theme.rem(2.75),
    paddingHorizontal: theme.rem(1.25),
    borderRadius: theme.radiusPill,
    backgroundColor: theme.primaryButtonColor
  },
  buttonPressed: {
    backgroundColor: theme.primaryButtonPressedColor
  },
  buttonLabel: {
    fontFamily: theme.semiBoldTextFont,
    fontWeight: '600',
    fontSize: theme.rem(1),
    color: theme.buttonTextColor
  }
}))

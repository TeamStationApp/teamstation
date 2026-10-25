import React, { useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

import { Icon } from '../components/Icon'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { TessStep, TessStepStatus } from './tessTypes'

/**
 * What Tess did for a reply, above its text: one row, "Thinking" with a
 * spinner while she works, "Thought for 12s" once she is done (just
 * "Thinking" for a reply read from history, whose time is not kept), that
 * opens to the summary of her thinking and her steps, each with a spinner,
 * a check or a cross. Open while she works, closed afterwards; a tap on the
 * row opens or closes it.
 */
export function TessThinking({
  thinking = '',
  steps = [],
  live = false,
  seconds
}: {
  thinking?: string
  steps?: readonly TessStep[]
  /** She is still working on this reply. */
  live?: boolean
  /** How long she thought, when the chat saw her do it. */
  seconds?: number
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [open, setOpen] = useState(live)
  const title =
    !live && seconds != null
      ? sprintf(lstrings.tess_thought_for, String(seconds))
      : lstrings.tess_thinking_live
  return (
    <View testID="Tess thought" style={styles.thought}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        aria-expanded={open}
        onPress={() => {
          setOpen(shown => !shown)
        }}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        {live ? (
          <ActivityIndicator size="small" color={theme.secondaryTextColor} />
        ) : (
          <Icon name="auto_awesome" size={1} color={theme.secondaryTextColor} />
        )}
        <Text numberOfLines={1} style={styles.title}>
          {title}
        </Text>
        <View style={open && styles.turned}>
          <Icon
            name="chevron_right"
            size={1}
            color={theme.secondaryTextColor}
          />
        </View>
      </Pressable>
      {open && (thinking !== '' || steps.length > 0) && (
        <View testID="Tess thought body" style={styles.body}>
          {thinking !== '' && (
            <Text
              selectable
              testID="Tess thought summary"
              style={styles.summary}
            >
              {thinking}
            </Text>
          )}
          {steps.map((step, at) => (
            <View
              key={at}
              testID="Tess step"
              accessible
              accessibilityLabel={stepLabel(step)}
              style={styles.step}
            >
              <View style={styles.mark}>
                <StepMark status={step.status} />
              </View>
              <Text style={styles.stepText}>{step.label}</Text>
            </View>
          ))}
        </View>
      )}
    </View>
  )
}

function stepLabel(step: TessStep): string {
  return sprintf(
    step.status === 'running'
      ? lstrings.tess_step_running
      : step.status === 'done'
        ? lstrings.tess_step_done
        : lstrings.tess_step_failed,
    step.label
  )
}

/** A spinner while a step runs, then a check, or a cross when it failed. */
function StepMark({ status }: { status: TessStepStatus }): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  if (status === 'running')
    return <ActivityIndicator size="small" color={theme.secondaryTextColor} />
  if (status === 'failed')
    return (
      <View testID="Tess step failed">
        <Icon name="close" size={1} color={theme.dangerColor} />
      </View>
    )
  // Drawn, since the phone's icon font carries no check.
  return <View testID="Tess step done" style={styles.check} />
}

const getStyles = cacheStyles((theme: Theme) => ({
  thought: { alignSelf: 'stretch' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: theme.rem(theme.spaceXsRem),
    minHeight: theme.rem(2)
  },
  pressed: { opacity: 0.6 },
  title: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.secondaryTextColor
  },
  turned: { transform: [{ rotate: '90deg' }] },
  body: {
    gap: theme.rem(theme.spaceXsRem),
    marginLeft: theme.rem(0.5),
    paddingLeft: theme.rem(theme.spaceSmRem),
    borderLeftWidth: 2,
    borderLeftColor: theme.defaultBorderColor
  },
  summary: {
    fontFamily: theme.regularTextFont,
    fontStyle: 'italic',
    fontSize: theme.rem(0.8125),
    lineHeight: theme.rem(1.1875),
    color: theme.secondaryTextColor
  },
  step: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    minHeight: theme.rem(1.5)
  },
  mark: {
    width: theme.rem(1.25),
    alignItems: 'center',
    justifyContent: 'center'
  },
  check: {
    width: theme.rem(0.375),
    height: theme.rem(0.75),
    marginBottom: theme.rem(0.125),
    borderRightWidth: 2,
    borderBottomWidth: 2,
    borderColor: theme.successColor,
    transform: [{ rotate: '45deg' }]
  },
  stepText: {
    flexShrink: 1,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.primaryTextColor
  }
}))

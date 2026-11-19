import React, { useEffect, useRef, useState } from 'react'
import { Text } from 'react-native'

import { useChatAge } from '../chat/ChatAgeGate'
import { useDeviceApprovals } from '../chat/DeviceApprovalPrompt'
import { Button } from '../components/Button'
import { CancelAction } from '../components/CancelAction'
import { useModalPresence, useModalsOpen } from '../components/modalPresence'
import { Sheet } from '../components/Sheet'
import { lstrings } from '../locales/strings'
import { openNotificationSettings } from '../platform/notificationSettings'
import { pushDevice } from '../platform/pushDevice'
import type { PushClient } from '../platform/pushState'
import type { UserSettingStorage } from '../platform/userSetting'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  answerAsk,
  type AskDevice,
  type AskQuestion,
  startAsk
} from './notificationAsk'
import type { NotificationAskState } from './notificationAskContext'

/** The question on show, for whom, and how far it has got. */
interface Showing {
  userId: string
  question: AskQuestion
  /** Continue could not open the settings: where to allow them instead. */
  hint: boolean
  busy: boolean
}

export interface NotificationAskHostProps {
  state: NotificationAskState
  client: PushClient
  /** Who is signed in; nobody is asked while nobody is. */
  userId: string | undefined
  /** A chat surface is on show: a messaging request waits for one. */
  chatShown: boolean
  device?: AskDevice
  storage?: UserSettingStorage
  openSettings?: () => Promise<boolean>
}

/**
 * The ask, drawn by the shell beside the stack, over whatever screen is on
 * top. A request starts once no modal is on show (`modalPresence`); a
 * messaging one also waits for chat's own gates (the age sheet agreed to,
 * this device's approvals read and none waiting to be answered) with a chat
 * surface on show, and is dropped when chat stays locked to this person or
 * they leave chat first. Allowed already, it turns both switches on with no
 * question; asked already, or on a device that cannot notify, it does
 * nothing. A question waits again if a modal came up while it was being
 * worked out, and once up it claims the screen: any other modal waits for it
 * to go. A different person signed in takes down the question, and anything
 * still under way for the last one.
 */
export function NotificationAskHost(
  props: NotificationAskHostProps
): React.ReactElement | null {
  const {
    state,
    client,
    userId,
    chatShown,
    device = pushDevice,
    storage,
    openSettings = openNotificationSettings
  } = props
  const { pending, settle, actions } = state
  const { request, withdraw } = actions
  const presence = useModalPresence()
  const open = useModalsOpen()
  const { access } = useChatAge()
  const { controller, state: approvals } = useDeviceApprovals()
  const approvalsDone = controller == null || approvals.settled
  const [showing, setShowing] = useState<Showing>()
  const [starting, setStarting] = useState(false)
  const messaging = pending.has('messaging')
  const chatReady = access === 'allowed' && approvalsDone && chatShown
  /** What holds a question back now, for an answer that comes later. */
  const now = useRef({ chatShown, chatReady })
  now.current = { chatShown, chatReady }
  /**
   * Counts each time chat is left: a messaging request worked out before
   * then is not chat's to ask again, even should a chat surface be on show
   * by the time it answers (one reached from a notification's tap or a link).
   */
  const chatLeft = useRef(0)
  const inChat = useRef(chatShown)
  if (inChat.current !== chatShown) {
    inChat.current = chatShown
    if (!chatShown) chatLeft.current++
  }

  /** Counts who has been signed in: an answer for someone before is dropped. */
  const signIn = useRef(0)
  const signedIn = useRef(userId)
  if (signedIn.current !== userId) {
    signedIn.current = userId
    signIn.current++
  }
  useEffect(() => {
    setShowing(undefined)
  }, [userId])

  // Under 13 on this device, chat never opens: nor does its ask.
  useEffect(() => {
    if (messaging && access === 'blocked') withdraw('messaging')
  }, [messaging, access, withdraw])
  // Left before its gates were done: entering messaging again asks again.
  const sawChat = useRef(false)
  useEffect(() => {
    if (!messaging) sawChat.current = false
    else if (chatShown) sawChat.current = true
    else if (sawChat.current) {
      sawChat.current = false
      withdraw('messaging')
    }
  }, [messaging, chatShown, withdraw])
  // Nobody to ask: what was waiting was someone else's.
  useEffect(() => {
    if (userId == null && pending.size > 0) settle()
  }, [userId, pending, settle])

  const ready =
    userId != null &&
    showing == null &&
    !starting &&
    open === 0 &&
    (pending.has('rsvp') || (messaging && chatReady))
  useEffect(() => {
    if (!ready) return
    const user = userId
    const turn = signIn.current
    const left = chatLeft.current
    const reasons = [...pending]
    settle()
    setStarting(true)
    startAsk(device, client, user, { storage })
      .then(question => {
        if (question == null || turn !== signIn.current) return
        // A modal came up (read from the count itself, which may be ahead
        // of the last render), or chat's gates closed, while it was worked
        // out: it waits for its moment again. Chat's waits only while the
        // person is still in the chat they entered; left, it is dropped.
        const stayed = chatLeft.current === left
        const clear =
          presence.open() === 0 &&
          (reasons.includes('rsvp') || (stayed && now.current.chatReady))
        if (clear) {
          setShowing({ userId: user, question, hint: false, busy: false })
          return
        }
        if (reasons.includes('rsvp')) request('rsvp')
        if (reasons.includes('messaging') && stayed && now.current.chatShown) {
          sawChat.current = true
          request('messaging')
        }
      })
      .catch(() => undefined)
      .finally(() => {
        setStarting(false)
      })
    // Started once for each moment it becomes ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  if (showing == null || showing.userId !== userId) return null
  const turn = signIn.current
  /** Changes the question, while it is still this person's. */
  const update = (next: (current: Showing) => Showing | undefined): void => {
    if (turn !== signIn.current) return
    setShowing(current => (current == null ? current : next(current)))
  }
  const close = (): void => {
    update(() => undefined)
  }
  const answer = (choice: 'notNow' | 'continue'): void => {
    const { question } = showing
    const answered = answerAsk(
      device,
      client,
      showing.userId,
      question,
      choice,
      {
        storage,
        openSettings
      }
    )
    // The system's question, or the way to settings, goes on over the
    // screen, not the sheet; only the web's hint keeps it up.
    if (choice === 'notNow' || question === 'prompt') {
      close()
      answered.catch(() => undefined)
      return
    }
    update(current => ({ ...current, busy: true }))
    answered
      .then(next => {
        if (next === 'hint')
          update(current => ({ ...current, hint: true, busy: false }))
        else close()
      })
      .catch(close)
  }
  return (
    <NotificationAskSheet
      hint={showing.hint}
      busy={showing.busy}
      onNotNow={() => {
        answer('notNow')
      }}
      onContinue={() => {
        answer('continue')
      }}
      onDone={close}
    />
  )
}

/**
 * The app's own question before the system's: why notifications help, with
 * Continue and Not Now, or, where Continue cannot open this device's
 * settings, where to allow them instead.
 */
export function NotificationAskSheet(props: {
  hint: boolean
  busy?: boolean
  onNotNow: () => void
  onContinue: () => void
  onDone: () => void
}): React.ReactElement {
  const { hint, busy = false, onNotNow, onContinue, onDone } = props
  const styles = getStyles(useTheme())
  return (
    <Sheet
      // Dismissed outside the sheet, it is answered as it reads; not while
      // Continue is under way.
      onClose={hint ? onDone : onNotNow}
      closeLabel={
        hint ? lstrings.common_done : lstrings.notifications_ask_not_now
      }
      closable={!busy}
      claims
      style={styles.sheet}
      testID="notification-ask"
    >
      <Text style={styles.title} accessibilityRole="header">
        {lstrings.notifications_ask_title}
      </Text>
      {hint ? (
        <>
          <Text
            style={styles.body}
            accessibilityRole="alert"
            testID="notification-ask-hint"
          >
            {lstrings.notifications_ask_web_blocked}
          </Text>
          <Button
            label={lstrings.common_done}
            block
            testID="notification-ask-done"
            onPress={onDone}
          />
        </>
      ) : (
        <>
          <Button
            label={lstrings.notifications_ask_continue}
            block
            busy={busy}
            disabled={busy}
            testID="notification-ask-continue"
            onPress={onContinue}
          />
          <CancelAction
            label={lstrings.notifications_ask_not_now}
            disabled={busy}
            testID="notification-ask-not-now"
            onPress={onNotNow}
          />
        </>
      )}
    </Sheet>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  // On the canvas's own colour, which its text is drawn for in every
  // theme: a card's surface is the canvas text's colour in the dark one.
  sheet: {
    backgroundColor: theme.backgroundColor,
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    padding: theme.rem(theme.spaceLgRem),
    gap: theme.rem(theme.spaceMdRem)
  },
  title: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700',
    lineHeight: theme.rem(1.5),
    color: theme.primaryTextColor
  },
  body: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    lineHeight: theme.rem(1.375),
    color: theme.primaryTextColor
  }
}))

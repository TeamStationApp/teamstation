import React, {
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState
} from 'react'

import { useTheme } from '../theme/ThemeContext'
import { RosterClipContext, useRosterGesture } from './RosterDragContext'
import type { RosterDragProps } from './rosterDragProps'
import { RosterHold } from './rosterHold'
export { RosterDragGroup, RosterScrollArea } from './RosterDragContext'
export function RosterDrag(props: RosterDragProps): React.ReactElement {
  const engine = useRosterGesture()
  const clip = useContext(RosterClipContext)
  const theme = useTheme()
  const node = useRef<HTMLDivElement>(null)
  const moved = useRef(false)
  const releasing = useRef(false)
  const cancelledGrabEscape = useRef(false)
  const [grab, setGrab] = useState<number>()
  const [hover, setHover] = useState<false | 'before' | 'after' | 'row'>(false)
  const latest = useRef(props)
  latest.current = props
  const contact = useRef<{ pointer: number; kind: string } | null>(null)
  const [hold] = useState(
    () =>
      new RosterHold(point => {
        const p = latest.current
        if (p.playerId == null || p.disabled === true) return
        moved.current = true
        engine.begin(p.playerId, p.label ?? '', point)
        if (contact.current?.kind !== 'touch' && contact.current != null)
          node.current?.setPointerCapture(contact.current.pointer)
      })
  )
  const cancel = useCallback((): void => {
    hold.cancel()
    contact.current = null
    if (engine.active?.id === latest.current.playerId) engine.cancel()
  }, [engine, hold])
  useEffect(() => {
    const host = node.current!
    const start = (event: TouchEvent): void => {
      if (
        event.touches.length !== 1 ||
        latest.current.disabled === true ||
        latest.current.playerId == null ||
        childButton(event.target!)
      )
        return
      const touch = event.touches[0]
      moved.current = false
      contact.current = { pointer: touch.identifier, kind: 'touch' }
      hold.start({ x: touch.clientX, y: touch.clientY })
    }
    const move = (event: TouchEvent): void => {
      if (contact.current?.kind !== 'touch') return
      if (event.touches.length !== 1) {
        cancel()
        return
      }
      const touch = event.touches[0]
      const point = { x: touch.clientX, y: touch.clientY }
      hold.move(point)
      if (hold.active) {
        event.preventDefault()
        engine.move(point).catch(cancel)
      } else moved.current = true
    }
    const end = (event: TouchEvent): void => {
      if (contact.current?.kind !== 'touch') return
      const active = hold.active
      const tap = hold.finish()
      const touch = event.changedTouches[0]
      contact.current = null
      // Prevent the synthetic click; short taps are handled exactly once here.
      if (event.cancelable) event.preventDefault()
      moved.current = true
      if (active)
        engine.release({ x: touch.clientX, y: touch.clientY }).catch(cancel)
      else if (tap) latest.current.onTap?.()
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && contact.current != null) {
        cancelledGrabEscape.current = true
        moved.current = true
        cancel()
      }
    }
    host.addEventListener('touchstart', start, { passive: true })
    host.addEventListener('touchmove', move, { passive: false })
    host.addEventListener('touchend', end, { passive: false })
    host.addEventListener('touchcancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', escape)
    return () => {
      cancel()
      host.removeEventListener('touchstart', start)
      host.removeEventListener('touchmove', move)
      host.removeEventListener('touchend', end)
      host.removeEventListener('touchcancel', cancel)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', escape)
    }
  }, [engine, hold, cancel, props.playerId, props.disabled])
  const token = props.targetId
  useEffect(() => {
    if (token == null || props.onDropPlayer == null) return
    engine.targets.set(token, {
      measure: async () => {
        const rect = node.current!.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      },
      clip,
      insertion: props.insertion,
      drop: (id, edge) => {
        latest.current.onDropPlayer?.(id, edge)
      }
    })
    const timer = setInterval(() => {
      const preview = engine.preview
      setHover(preview?.target === token ? (preview.edge ?? 'row') : false)
    }, 40)
    return () => {
      clearInterval(timer)
      engine.targets.delete(token)
    }
  }, [engine, clip, token, props.onDropPlayer, props.insertion])
  const childButton = (target: EventTarget): boolean => {
    const button = (target as Element).closest('button,input,[role="button"]')
    return button != null && button !== node.current
  }
  const release = async (
    event: React.PointerEvent<HTMLDivElement>,
    cancel: boolean
  ): Promise<void> => {
    const host = event.currentTarget
    releasing.current = true
    moved.current ||= engine.active?.moved === true
    if (cancel) engine.cancel()
    else await engine.release({ x: event.clientX, y: event.clientY })
    if (host.hasPointerCapture(event.pointerId))
      host.releasePointerCapture(event.pointerId)
  }
  return (
    <div
      ref={node}
      data-roster-player={props.playerId}
      data-roster-target={props.targetId}
      role={
        props.onTap != null
          ? 'button'
          : props.onReorder != null
            ? 'group'
            : undefined
      }
      aria-label={props.label}
      aria-disabled={props.disabled}
      aria-roledescription={
        props.onReorder == null ? undefined : 'draggable lineup row'
      }
      aria-description={
        grab == null
          ? undefined
          : 'Grabbed. Arrow keys move; Enter drops; Escape cancels.'
      }
      tabIndex={
        props.disabled === true
          ? -1
          : props.onTap != null || props.onReorder != null
            ? 0
            : undefined
      }
      style={{
        touchAction: 'auto',
        WebkitTouchCallout: 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        opacity: props.disabled === true ? 0.4 : 1,
        outline:
          hover === 'row' || grab != null
            ? `2px solid ${theme.scoringMenuActiveBackground}`
            : undefined,
        borderRadius: 6,
        position: 'relative',
        cursor:
          props.disabled === true
            ? 'default'
            : props.playerId != null
              ? 'grab'
              : undefined
      }}
      onPointerDown={event => {
        if (
          event.pointerType === 'touch' ||
          props.disabled === true ||
          props.playerId == null ||
          event.button !== 0 ||
          childButton(event.target)
        )
          return
        event.stopPropagation()
        moved.current = false
        releasing.current = false
        contact.current = { pointer: event.pointerId, kind: event.pointerType }
        hold.start({ x: event.clientX, y: event.clientY })
      }}
      onPointerMove={event => {
        if (event.pointerType === 'touch') return
        hold.move({ x: event.clientX, y: event.clientY })
        if (engine.active?.id === props.playerId) {
          engine.move({ x: event.clientX, y: event.clientY }).catch(() => {
            engine.cancel()
          })
          moved.current ||= engine.active?.moved === true
        }
      }}
      onPointerUp={event => {
        if (event.pointerType === 'touch') return
        if (contact.current != null) moved.current ||= !hold.finish()
        contact.current = null
        if (engine.active?.id === props.playerId)
          release(event, false).catch(() => {
            engine.cancel()
          })
      }}
      onPointerCancel={event => {
        if (event.pointerType === 'touch') return
        cancel()
        release(event, true).catch(() => {
          engine.cancel()
        })
      }}
      onPointerLeave={() => {
        if (!hold.active && contact.current?.kind !== 'touch') {
          moved.current = true
          cancel()
        }
      }}
      onLostPointerCapture={event => {
        if (event.pointerType === 'touch') return
        if (!releasing.current && engine.active?.id === props.playerId)
          engine.cancel()
      }}
      onClick={event => {
        if (childButton(event.target)) return
        if (!moved.current && props.disabled !== true) props.onTap?.()
        moved.current = false
      }}
      onKeyUp={event => {
        // React Native Web's Modal also dismisses on keyup, after our keydown.
        if (event.key !== 'Escape' || !cancelledGrabEscape.current) return
        cancelledGrabEscape.current = false
        event.preventDefault()
        event.stopPropagation()
      }}
      onKeyDown={event => {
        if (childButton(event.target) || props.disabled === true) return
        if (
          event.key === 'Escape' &&
          (grab != null || cancelledGrabEscape.current)
        ) {
          cancelledGrabEscape.current = true
          event.preventDefault()
          event.stopPropagation()
          setGrab(undefined)
          return
        }
        if (grab != null && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault()
          setGrab(grab + (event.key === 'ArrowUp' ? -1 : 1))
          return
        }
        if (event.key !== ' ' && event.key !== 'Enter') return
        event.preventDefault()
        if (props.onReorder == null) props.onTap?.()
        else if (grab == null) setGrab(0)
        else {
          props.onReorder(grab)
          setGrab(undefined)
        }
      }}
    >
      {props.children}
      {(hover === 'before' || hover === 'after') && (
        <div
          aria-label="Lineup insertion point"
          style={{
            position: 'absolute',
            pointerEvents: 'none',
            left: 0,
            right: 0,
            height: 3,
            top: hover === 'before' ? -2 : undefined,
            bottom: hover === 'after' ? -2 : undefined,
            background: theme.scoringMenuActiveBackground
          }}
        />
      )}
    </div>
  )
}

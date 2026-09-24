import React, { useContext, useEffect, useRef, useState } from 'react'

import { useTheme } from '../theme/ThemeContext'
import { RosterClipContext, useRosterGesture } from './RosterDragContext'
import type { RosterDragProps } from './rosterDragProps'
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
  const [hover, setHover] = useState(false)
  const latest = useRef(props)
  latest.current = props
  const token = props.targetId
  useEffect(() => {
    if (token == null || props.onDropPlayer == null) return
    engine.targets.set(token, {
      measure: async () => {
        const rect = node.current!.getBoundingClientRect()
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      },
      clip,
      drop: id => {
        latest.current.onDropPlayer?.(id)
      }
    })
    const timer = setInterval(() => {
      const point = engine.active?.point
      const rect = node.current?.getBoundingClientRect()
      setHover(
        engine.active?.moved === true &&
          point != null &&
          rect != null &&
          point.x >= rect.left &&
          point.x <= rect.right &&
          point.y >= rect.top &&
          point.y <= rect.bottom
      )
    }, 80)
    return () => {
      clearInterval(timer)
      engine.targets.delete(token)
    }
  }, [engine, clip, token, props.onDropPlayer])
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
        touchAction:
          props.playerId == null || props.disabled === true ? 'auto' : 'none',
        userSelect: 'none',
        WebkitUserSelect: 'none',
        opacity: props.disabled === true ? 0.4 : 1,
        outline:
          hover || grab != null
            ? `2px solid ${theme.scoringMenuActiveBackground}`
            : undefined,
        borderRadius: 6,
        cursor:
          props.disabled === true
            ? 'default'
            : props.playerId != null
              ? 'grab'
              : undefined
      }}
      onPointerDown={event => {
        if (
          props.disabled === true ||
          props.playerId == null ||
          event.button !== 0 ||
          childButton(event.target)
        )
          return
        event.stopPropagation()
        moved.current = false
        releasing.current = false
        engine.begin(props.playerId, props.label ?? '', {
          x: event.clientX,
          y: event.clientY
        })
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        if (engine.active?.id === props.playerId) {
          engine.move({ x: event.clientX, y: event.clientY }).catch(() => {
            engine.cancel()
          })
          moved.current ||= engine.active?.moved === true
        }
      }}
      onPointerUp={event => {
        if (engine.active?.id === props.playerId)
          release(event, false).catch(() => {
            engine.cancel()
          })
      }}
      onPointerCancel={event => {
        release(event, true).catch(() => {
          engine.cancel()
        })
      }}
      onLostPointerCapture={() => {
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
    </div>
  )
}

import { tvLayout } from './tvLayout'

export type SidePanel = 'cameras' | 'highlights' | null
export interface PlaybackState {
  visible: number[]
  full: number | null
  side: SidePanel
  box: 'closed' | 'preview' | 'compact' | 'expanded'
  preview: boolean
  activity: number
  selectedClip: string | null
  clipEnd: number | null
  paused: boolean
}
export function initialPlayback(count: number): PlaybackState {
  return {
    visible: Array.from({ length: count }, (_, i) => i),
    full: null,
    side: null,
    box: 'closed',
    preview: false,
    activity: 0,
    selectedClip: null,
    clipEnd: null,
    paused: false
  }
}
export type PlaybackAction =
  | { type: 'reset'; count: number }
  | { type: 'ended' }
  | { type: 'ready'; count: number }
  | { type: 'open'; panel: Exclude<SidePanel, null> }
  | { type: 'box' }
  | { type: 'toggle'; index: number }
  | { type: 'enlarge'; index: number }
  | { type: 'activity' }
  | { type: 'cameraTimeout' }
  | { type: 'previewTimeout' }
  | { type: 'dismiss' }
  | { type: 'collapse' }
  | { type: 'pause' }
  | { type: 'seek' }
  | { type: 'clip'; id: string; end: number | null }
  | { type: 'progress'; wall: number }

export function playbackReducer(
  state: PlaybackState,
  action: PlaybackAction
): PlaybackState {
  switch (action.type) {
    case 'reset':
      return initialPlayback(action.count)
    case 'ended':
      return { ...state, paused: true }
    case 'ready':
      return {
        ...state,
        side: action.count > 1 ? 'cameras' : null,
        box: 'preview',
        preview: true
      }
    case 'open':
      return {
        ...state,
        side: action.panel,
        preview: false,
        activity: state.activity + 1
      }
    case 'box':
      return {
        ...state,
        box:
          state.box === 'compact' || state.box === 'expanded'
            ? 'expanded'
            : 'compact'
      }
    case 'toggle': {
      const visible = state.visible.includes(action.index)
        ? state.visible.length === 1
          ? state.visible
          : state.visible.filter(i => i !== action.index)
        : [...state.visible, action.index].sort((a, b) => a - b)
      return {
        ...state,
        visible,
        full: null,
        preview: false,
        activity: state.activity + 1
      }
    }
    case 'enlarge':
      return state.visible.length > 1 ? { ...state, full: action.index } : state
    case 'activity':
      return { ...state, activity: state.activity + 1 }
    case 'cameraTimeout':
      return state.side === 'cameras'
        ? { ...state, side: null, preview: false }
        : state
    case 'previewTimeout':
      return {
        ...state,
        side: state.preview ? null : state.side,
        box: state.box === 'preview' ? 'closed' : state.box,
        preview: false
      }
    case 'dismiss':
      return { ...state, side: null, box: 'closed', preview: false }
    case 'collapse':
      return { ...state, full: null }
    case 'pause':
      return { ...state, paused: !state.paused }
    case 'seek':
      return { ...state, clipEnd: null }
    case 'clip':
      return {
        ...state,
        selectedClip: action.id,
        clipEnd: action.end,
        side: null,
        box: 'closed',
        preview: false,
        paused: false
      }
    case 'progress':
      return state.clipEnd !== null && action.wall >= state.clipEnd
        ? { ...state, clipEnd: null, side: 'highlights', preview: false }
        : state
  }
}

/** Hidden surfaces retain their size and native player; only their composition changes. */
export function angleLayout(
  index: number,
  state: PlaybackState
): {
  left: number
  top: number
  width: number
  height: number
  opacity: number
  zIndex: number
} {
  const slot = state.visible.indexOf(index)
  const expanded =
    state.full === index ||
    (state.full === null && state.visible.length === 1 && slot === 0)
  const rect = tvLayout(state, { width: 1600, height: 900 }, null, false, true)
    .tiles[slot] ?? { x: 0, y: 0, w: 800, h: 450 }
  return {
    left: rect.x / 16,
    top: rect.y / 9,
    width: rect.w / 16,
    height: rect.h / 9,
    opacity: slot < 0 ? 0 : 1,
    zIndex: expanded ? 2 : 1
  }
}

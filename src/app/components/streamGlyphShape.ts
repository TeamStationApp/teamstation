export interface StreamGlyphProps {
  name: 'sidewaysPhone' | 'filmCamera'
  color: string
  /** In points. */
  size?: number
}

/** Filled paths on a 24 by 24 box, shared by the web and native drawings. */
export const STREAM_GLYPHS: Record<StreamGlyphProps['name'], string[]> = {
  // A phone on its side, with its screen cut out and a button at one end.
  sidewaysPhone: [
    'M4 6.5h16A2.5 2.5 0 0 1 22.5 9v6a2.5 2.5 0 0 1-2.5 2.5H4A2.5 2.5 0 0 1 1.5 15V9A2.5 2.5 0 0 1 4 6.5zM5 8.5v7h13.5v-7z',
    'M20.25 11a1 1 0 1 1 0 2 1 1 0 0 1 0-2z'
  ],
  // A cine camera: two reels on top, the body, and the lens hood at the right.
  filmCamera: [
    'M6.5 2.5a3.75 3.75 0 1 1 0 7.5 3.75 3.75 0 0 1 0-7.5z',
    'M13.75 3.5a3.25 3.25 0 1 1 0 6.5 3.25 3.25 0 0 1 0-6.5z',
    'M3.5 11h12A1.5 1.5 0 0 1 17 12.5v7a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 2 19.5v-7A1.5 1.5 0 0 1 3.5 11z',
    'M18 14.25 22.5 11.5v9L18 17.75z'
  ]
}

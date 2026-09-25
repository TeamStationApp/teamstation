import { useThree } from '@react-three/fiber'
import { useEffect, useState } from 'react'
import { SRGBColorSpace, type Texture, TextureLoader } from 'three'

/** Each dugout owns its image; a failed or stale request never blocks the field. */
export function useTeamLogo(url?: string | null): Texture | undefined {
  const invalidate = useThree(state => state.invalidate)
  const [loaded, setLoaded] = useState<{ url: string; texture: Texture }>()
  useEffect(() => {
    if (url == null || url === '') return
    let live = true
    const texture = new TextureLoader().load(
      url,
      image => {
        if (!live) return
        image.colorSpace = SRGBColorSpace
        setLoaded({ url, texture: image })
        invalidate()
      },
      undefined,
      () => {
        if (live) setLoaded(undefined)
      }
    )
    return () => {
      live = false
      texture.dispose()
    }
  }, [url, invalidate])
  return loaded?.url === url ? loaded?.texture : undefined
}

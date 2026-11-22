import React, { useState } from 'react'

import { Composer, type ComposerPicker, type ComposerProps } from './Composer'

export type TestComposerProps = Omit<ComposerProps, 'picker' | 'onPickerChange'>

export function TestComposer(props: TestComposerProps): React.ReactElement {
  const [picker, setPicker] = useState<ComposerPicker>()
  return <Composer {...props} picker={picker} onPickerChange={setPicker} />
}

import React from 'react'
import { createRoot } from 'react-dom/client'

import { ButtonIconsFixture } from './buttonIcons.fixture'
import { ButtonIconScreensFixture } from './buttonIconScreens.fixture'

const root = document.getElementById('root')
const screen = new URLSearchParams(window.location.search).get('screen')
if (root != null)
  createRoot(root).render(
    screen == null ? (
      <ButtonIconsFixture />
    ) : (
      <ButtonIconScreensFixture screen={screen} />
    )
  )

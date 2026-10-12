package app.teamstation.cameraman.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import app.teamstation.cameraman.ui.theme.CameramanTheme
import app.teamstation.streamcore.core.CameraLens
import app.teamstation.streamcore.core.CameraPosition
import app.teamstation.streamcore.core.LensSelection
import app.teamstation.streamcore.core.StreamSettings
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The Video and Lenses settings cards, drawn from the shared library's settings and lens types. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsCardsTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun `the video card shows the range while adapting and the one rate otherwise`() {
        val adapting = StreamSettings(bitrate = 8_000_000, bitrateFloor = 2_000_000, adaptiveBitrate = true)
        rule.setContent {
            CameramanTheme { VideoCard(draft = adapting, options = emptyList(), selected = null, onDraftChange = {}) }
        }
        rule.onNodeWithTag("settings-bitrate-value").assertTextEquals("Bitrate  2.0–8.0 Mbps")
    }

    @Test
    fun `the video card shows one rate when not adapting`() {
        val fixed = StreamSettings(bitrate = 6_000_000, adaptiveBitrate = false)
        rule.setContent {
            CameramanTheme { VideoCard(draft = fixed, options = emptyList(), selected = null, onDraftChange = {}) }
        }
        rule.onNodeWithTag("settings-bitrate-value").assertTextEquals("Bitrate  6.0 Mbps")
    }

    @Test
    fun `the lenses card labels each lens with its zoom`() {
        val wide = CameraLens("0", CameraPosition.BACK, "2", 24, 1.0, 1.0)
        val ultraWide = CameraLens("1", CameraPosition.BACK, "3", 13, 0.5, 0.5)
        rule.setContent {
            CameramanTheme { LensesCard(listOf(ultraWide, wide), LensSelection(), onToggle = { _, _ -> }) }
        }
        rule.onNodeWithText("0.5x").assertIsDisplayed()
        rule.onNodeWithText("1x").assertIsDisplayed()
        rule.onNodeWithTag(wide.testTag).assertIsDisplayed()
    }
}

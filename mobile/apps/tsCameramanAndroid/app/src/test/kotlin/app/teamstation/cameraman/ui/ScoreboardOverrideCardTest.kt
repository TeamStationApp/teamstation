package app.teamstation.cameraman.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import app.teamstation.cameraman.radar.ScoreboardRoute
import app.teamstation.cameraman.scoreboard.ScoreboardEventRow
import app.teamstation.cameraman.scoreboard.ScoreboardUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Change Game under the event, "Allow Director Override" under that, "Override from Director <ip>"
 * directly under it while a Director holds the event, and Change Game and the picker off then.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w800dp-h2400dp")
class ScoreboardOverrideCardTest {
    @get:Rule
    val rule = createComposeRule()

    private val base = ScoreboardUiState(
        route = ScoreboardRoute.Event,
        signedIn = true,
        gameTitle = "Pioneers at Comets",
        gameWhen = "Tue Sep 22, 2026 1:30 AM",
        overrideToggleEnabled = true,
        upcoming = listOf(ScoreboardEventRow("gam_demoC", "Comets at Pioneers", "2026-09-23T18:00:00Z", "later"))
    )

    private fun show(state: ScoreboardUiState, onAllow: (Boolean) -> Unit = {}, onOpen: () -> Unit = {}) {
        rule.setContent {
            MaterialTheme {
                Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                    ScoreboardSettingsCard(
                        state = state,
                        onRoute = {},
                        onV1 = { _, _ -> },
                        onOpenEvents = onOpen,
                        onDismissEvents = {},
                        onChoose = {},
                        onAllowOverride = onAllow
                    )
                }
            }
        }
    }

    @Test
    fun `the toggle sits under the event, off by default, and reports a tap`() {
        val taps = ArrayList<Boolean>()
        var opened = 0
        show(base, onAllow = { taps += it }, onOpen = { opened += 1 })
        val toggle = rule.onNodeWithTag("scoreboard-allow-override")
        toggle.assertIsDisplayed().assertIsEnabled().assertIsOff()
        rule.onNodeWithText("Allow Director Override").assertIsDisplayed()
        rule.onNodeWithTag("scoreboard-override-from").assertDoesNotExist()
        toggle.performClick()
        assertEquals(listOf(true), taps)

        val event = rule.onNodeWithTag("scoreboard-choose-event").getUnclippedBoundsInRoot()
        val under = toggle.getUnclippedBoundsInRoot()
        assertTrue("toggle ${under.top} under event ${event.bottom}", under.top >= event.bottom)
        rule.onNodeWithTag("scoreboard-choose-event").assertIsEnabled().performClick()
        assertEquals(1, opened)
    }

    @Test
    fun `Change Game sits between the event and the toggle and opens the picker`() {
        var opened = 0
        show(base, onOpen = { opened += 1 })
        val change = rule.onNodeWithTag("scoreboard-change-game")
        change.assertIsDisplayed().assertIsEnabled()
        rule.onNodeWithText("Change Game").assertIsDisplayed()
        val event = rule.onNodeWithTag("scoreboard-choose-event").getUnclippedBoundsInRoot()
        val button = change.getUnclippedBoundsInRoot()
        val toggle = rule.onNodeWithTag("scoreboard-allow-override").getUnclippedBoundsInRoot()
        assertTrue("button ${button.top} under event ${event.bottom}", button.top >= event.bottom)
        assertTrue("toggle ${toggle.top} under button ${button.bottom}", toggle.top >= button.bottom)
        change.performClick()
        assertEquals(1, opened)
    }

    @Test
    fun `while a Director holds the event, Change Game is off and the event stays readable`() {
        var opened = 0
        show(base.copy(allowOverride = true, overrideHost = "192.0.2.10", eventLocked = true), onOpen = { opened += 1 })
        rule.onNodeWithTag("scoreboard-change-game").assertIsDisplayed().assertIsNotEnabled().performClick()
        assertEquals(0, opened)
        rule.onNodeWithText("Pioneers at Comets").assertIsDisplayed()
        rule.onNodeWithText("Tue Sep 22, 2026 1:30 AM").assertIsDisplayed()
    }

    @Test
    fun `while a Director holds the event, its address shows and the picker is off`() {
        show(
            base.copy(
                allowOverride = true,
                overrideHost = "192.0.2.10",
                eventLocked = true,
                pickerOpen = true
            )
        )
        rule.onNodeWithTag("scoreboard-allow-override").assertIsOn()
        val from = rule.onNodeWithTag("scoreboard-override-from")
        from.assertIsDisplayed()
        rule.onNodeWithText("Override from Director 192.0.2.10").assertIsDisplayed()
        rule.onNodeWithTag("scoreboard-choose-event").assertIsNotEnabled()
        rule.onNodeWithText("Pioneers at Comets").assertIsDisplayed()
        rule.onNodeWithText("Comets at Pioneers").assertDoesNotExist()

        val toggle = rule.onNodeWithTag("scoreboard-allow-override").getUnclippedBoundsInRoot()
        val row = from.getUnclippedBoundsInRoot()
        assertTrue("attribution ${row.top} under toggle ${toggle.bottom}", row.top >= toggle.bottom)
    }

    @Test
    fun `signed out, the toggle is grayed, and a problem gets its line`() {
        show(
            base.copy(
                signedIn = false,
                overrideToggleEnabled = false,
                overrideStatus = "Ports 47614 and 47615 are in use"
            )
        )
        rule.onNodeWithTag("scoreboard-allow-override").assertIsNotEnabled()
        rule.onNodeWithText("Ports 47614 and 47615 are in use").assertIsDisplayed()
    }
}

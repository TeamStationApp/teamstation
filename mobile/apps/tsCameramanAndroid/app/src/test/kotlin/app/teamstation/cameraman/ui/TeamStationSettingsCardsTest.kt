package app.teamstation.cameraman.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.getUnclippedBoundsInRoot
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.unit.dp
import app.teamstation.cameraman.radar.ScoreboardRoute
import app.teamstation.cameraman.scoreboard.ScoreboardUiState
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * The settings cards the plan draws: sign-in at the top, the scoreboard at the bottom,
 * and the account actions as wide filled buttons.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w800dp-h2400dp")
class TeamStationSettingsCardsTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun `sign-in is a pill card above the scoreboard, and the event shows its time`() {
        val state = ScoreboardUiState(
            route = ScoreboardRoute.Event,
            signedIn = false,
            awaitingCode = true,
            accountHost = "devhost3.example-ts.test",
            accountServer = "https://devhost3.example-ts.test",
            gameTitle = "Owls at Hawks",
            gameWhen = "Mon 9/28 3:05 PM"
        )
        rule.setContent {
            MaterialTheme(
                colorScheme = darkColorScheme(
                    primary = Color(0xFF80D99B),
                    onPrimary = Color(0xFF00391B),
                    surfaceContainer = Color(0xFF202125),
                    onSurface = Color(0xFFE2E2E6),
                    onSurfaceVariant = Color(0xFFC4C6CF),
                    background = Color(0xFF121316)
                )
            ) {
                SettingsBody(
                    header = {
                        TeamStationLoginCard(
                            state = state,
                            onSendCode = {},
                            onVerify = { _, _ -> },
                            onSignOut = {}
                        )
                    },
                    left = { Text("Video", modifier = Modifier.testTag("settings-left")) },
                    right = { Text("Lenses", modifier = Modifier.testTag("settings-right")) },
                    footer = {
                        ScoreboardSettingsCard(
                            state = state,
                            onRoute = {},
                            onV1 = { _, _ -> },
                            onOpenEvents = {},
                            onDismissEvents = {},
                            onChoose = {}
                        )
                    }
                )
            }
        }

        rule.onNodeWithTag("scoreboard-account-server", useUnmergedTree = true).assertIsDisplayed()
        rule.onNodeWithTag("scoreboard-account-server", useUnmergedTree = true)
            .assert(hasSetTextAction().not())
        rule.onNodeWithText("devhost3.example-ts.test").assertIsDisplayed()
        rule.onNodeWithText("Account server").assertDoesNotExist()
        rule.onNodeWithText("Tap to Login").assertIsDisplayed()
        rule.onNodeWithText("Email sign-in code").assertDoesNotExist()

        val login = rule.onNodeWithTag("settings-teamstation").getUnclippedBoundsInRoot()
        val board = rule.onNodeWithTag("settings-scoreboard").getUnclippedBoundsInRoot()
        assertTrue("login top ${login.top} scoreboard top ${board.top}", login.top < board.top)
        assertTrue("login height ${login.bottom - login.top}", login.bottom > login.top)

        val title = rule.onNodeWithText("Owls at Hawks", useUnmergedTree = true).getUnclippedBoundsInRoot()
        val whenLine = rule.onNodeWithText("Mon 9/28 3:05 PM", useUnmergedTree = true).getUnclippedBoundsInRoot()
        assertTrue("time top ${whenLine.top} title top ${title.top}", whenLine.top < title.top)
        assertTrue("time left ${whenLine.left} title left ${title.left}", whenLine.left == title.left)
    }

    @Test
    fun `a signed-in account shows Sign Out as a button`() {
        rule.setContent {
            MaterialTheme {
                Column {
                    TeamStationLoginCard(
                        state = ScoreboardUiState(
                            signedIn = true,
                            accountLabel = "ada@example.com",
                            accountHost = "app.teamstation.app"
                        ),
                        onSendCode = {},
                        onVerify = { _, _ -> },
                        onSignOut = {}
                    )
                }
            }
        }
        rule.onNodeWithText("ada@example.com currently logged in").assertIsDisplayed()
        rule.onNodeWithText("Logout").assertIsDisplayed()
        rule.onNodeWithText("app.teamstation.app").assertDoesNotExist()
        rule.onNodeWithTag("scoreboard-account-server", useUnmergedTree = true).assertDoesNotExist()
    }

    private fun assertPill(tag: String, label: String) {
        val node = rule.onNodeWithTag(tag)
        node.assertIsDisplayed().assertHasClickAction()
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Button))
        rule.onNodeWithText(label).assertIsDisplayed()
        val bounds = node.getUnclippedBoundsInRoot()
        val width = bounds.right - bounds.left
        val height = bounds.bottom - bounds.top
        assertTrue("$tag width $width", width > 200.dp)
        assertTrue("$tag height $height", height >= 40.dp)
    }
}

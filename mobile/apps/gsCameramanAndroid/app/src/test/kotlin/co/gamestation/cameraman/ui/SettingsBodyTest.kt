package co.gamestation.cameraman.ui

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertLeftPositionInRootIsEqualTo
import androidx.compose.ui.test.hasScrollAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SettingsBodyTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun `one scroll holds both columns and the cutout inset`() {
        val insetPx = 40
        rule.setContent {
            SettingsBody(
                horizontalInsets = WindowInsets(left = insetPx, top = 80, right = insetPx, bottom = 0),
                left = { Text("left", modifier = Modifier.testTag("settings-left")) },
                right = { Text("right", modifier = Modifier.testTag("settings-right")) }
            )
        }

        val cutout = with(rule.density) { insetPx.toDp() }
        rule.onNodeWithTag("settings-scroll").assertLeftPositionInRootIsEqualTo(cutout)
        rule.onNodeWithTag("settings-left").assertLeftPositionInRootIsEqualTo(cutout + 14.dp)
        rule.onNodeWithTag("settings-scroll").assert(hasScrollAction())
        rule.onNodeWithTag("settings-left").assert(hasScrollAction().not())
        rule.onNodeWithTag("settings-right").assert(hasScrollAction().not())
    }
}

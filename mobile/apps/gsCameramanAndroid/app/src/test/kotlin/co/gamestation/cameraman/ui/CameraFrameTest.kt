package co.gamestation.cameraman.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertLeftPositionInRootIsEqualTo
import androidx.compose.ui.test.assertWidthIsEqualTo
import androidx.compose.ui.test.getUnclippedBoundsInRoot
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
class CameraFrameTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun `a wide screen letterboxes a 16 by 9 frame and keeps the sides empty of chrome`() {
        rule.setContent {
            Box(
                Modifier
                    .requiredSize(width = 800.dp, height = 360.dp)
                    .testTag("screen")
            ) {
                CameraFrame(aspectRatio = 16f / 9f) {
                    Box(
                        Modifier
                            .align(Alignment.TopStart)
                            .size(10.dp)
                            .testTag("chrome")
                    )
                }
            }
        }
        val inset = rule.onNodeWithTag("screen").getUnclippedBoundsInRoot().left + 80.dp
        rule.onNodeWithTag("camera-frame").assertWidthIsEqualTo(640.dp)
        rule.onNodeWithTag("camera-frame").assertLeftPositionInRootIsEqualTo(inset)
        rule.onNodeWithTag("chrome").assertLeftPositionInRootIsEqualTo(inset)
    }
}

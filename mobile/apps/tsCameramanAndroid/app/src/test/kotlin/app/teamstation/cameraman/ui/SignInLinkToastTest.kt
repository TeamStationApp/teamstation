package app.teamstation.cameraman.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SignInLinkToastTest {
    @get:Rule
    val rule = createComposeRule()

    @Test
    fun `shows a link's outcome, and nothing without one`() {
        var message by mutableStateOf("This link is for https://seat.example.test. This app signs in to https://api.example.test.")
        rule.setContent { SignInLinkToast(message) }
        rule.onNodeWithTag("sign-in-link-message").assertIsDisplayed()
        rule.onNodeWithText("This link is for https://seat.example.test. This app signs in to https://api.example.test.")
            .assertTextEquals("This link is for https://seat.example.test. This app signs in to https://api.example.test.")
        message = ""
        rule.onNodeWithTag("sign-in-link-message").assertDoesNotExist()
    }
}

package app.teamstation.cameraman.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class LoginFlowTest {
    @Test
    fun theFieldStartsAsTheAddressAndBecomesTheCode() {
        val sent = LoginFlow().codeSent()
        assertEquals(LoginFlow.Step.Code, sent.step)
        assertEquals(LoginFlow.CHECK_EMAIL, sent.notice)
        assertEquals(LoginFlow.SIGN_IN_LABEL, sent.buttonLabel)
        assertTrue(sent.fieldIsCode)
        assertEquals("", sent.code)
    }

    @Test
    fun theSixthDigitSubmitsAndFiveDoNot() {
        val sent = LoginFlow().codeSent()
        val five = sent.replaceCode("12345")
        assertFalse(five.second)
        assertEquals("12345", five.first.code)
        val six = five.first.replaceCode("123456")
        assertTrue(six.second)
        assertEquals("123456", six.first.code)
        assertFalse(six.first.replaceCode("123456").second)
        val trimmed = six.first.replaceCode("12a34b56c789")
        assertFalse(trimmed.second)
        assertEquals("123456", trimmed.first.code)
    }

    @Test
    fun aRejectedCodeStaysOnTheCodeStep() {
        val rejected = LoginFlow().codeSent().replaceCode("000000").first.codeRejected()
        assertEquals(LoginFlow.Step.Code, rejected.step)
        assertEquals(LoginFlow.BAD_CODE, rejected.notice)
        assertEquals("", rejected.code)
        assertEquals(LoginFlow.SIGN_IN_LABEL, rejected.buttonLabel)
    }

    @Test
    fun cancelReturnsToTheAddress() {
        val cancelled = LoginFlow(email = "paul@vtex.net").codeSent().cancel()
        assertEquals(LoginFlow.Step.Email, cancelled.step)
        assertEquals("", cancelled.code)
        assertEquals(null, cancelled.notice)
        assertEquals("paul@vtex.net", cancelled.email)
        assertEquals(LoginFlow.SEND_LABEL, cancelled.buttonLabel)
        assertFalse(cancelled.fieldIsCode)
    }

    @Test
    fun logoutArmsFromTheRightSideAndOnlyASlideConfirms() {
        val armed = LoginFlow().armLogout()
        assertTrue(armed.logoutArmed)
        val swallowed = armed.tapElsewhere()
        assertTrue(swallowed.logoutArmed)
        val idle = swallowed.tapElsewhere()
        assertFalse(idle.logoutArmed)
        val again = idle.armLogout().tapElsewhere()
        val short = again.slide(0.79)
        assertFalse(short.second)
        assertTrue(short.first.logoutArmed)
        val done = short.first.slide(0.8)
        assertTrue(done.second)
        assertFalse(done.first.logoutArmed)
        assertFalse(LoginFlow().slide(1.0).second)
    }

    @Test
    fun aDevelopmentHostIsTextAndProductionIsNot() {
        assertFalse(LoginFlow.showsDevelopmentHost(""))
        assertFalse(LoginFlow.showsDevelopmentHost("app.teamstation.app"))
        assertFalse(LoginFlow.showsDevelopmentHost("https://app.teamstation.app"))
        assertTrue(LoginFlow.showsDevelopmentHost("devhost3.example-ts.test"))
        assertEquals(
            "paul@vtex.net currently logged in",
            LoginFlow.loggedInLine("paul@vtex.net")
        )
    }
}

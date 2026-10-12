package app.teamstation.cameraman.scoreboard

import android.content.Intent
import android.net.Uri
import app.teamstation.streamcore.core.InMemorySettingsStore
import app.teamstation.cameraman.radar.ScoreboardSocketTarget
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.io.IOException
import java.time.ZoneId

private const val TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456"
private const val APP = "https://app1.example.test"
private const val OWN = "https://api.example.test"

/** Reading a link the way TeamStationKit's `SignInLink` does. */
class SignInLinkTest {
    private fun read(url: String, app: String = APP) = SignInLink.read(url, app, OWN)

    @Test
    fun spendsALinkForThisServerOrNone() {
        assertEquals(SignInLink.Spend(TOKEN), read("$APP/signin/$TOKEN"))
        assertEquals(SignInLink.Spend(TOKEN), read("https://APP1.example.test/signin/$TOKEN?server=https%3A%2F%2Fapi.example.test"))
    }

    @Test
    fun asksBeforeSpendingALinkForAnotherName() {
        assertEquals(
            SignInLink.Confirm(TOKEN, "https://web.example.test"),
            read("$APP/signin/$TOKEN?x=1&server=https%3A%2F%2Fweb.example.test")
        )
    }

    @Test
    fun isNoSignInLinkOffTheAppsHostOrPath() {
        for (url in listOf(
            "https://other.example.test/signin/$TOKEN",
            "https://app1.example.test:8443/signin/$TOKEN",
            "http://app1.example.test/signin/$TOKEN",
            "$APP/games/g1",
            "$APP/signin/short",
            "$APP/signin/$TOKEN/more",
            "tscameraman://test/x",
            "not a url at all"
        )) assertEquals(url, SignInLink.NotSignIn, read(url))
        assertEquals(SignInLink.NotSignIn, read("$APP/signin/$TOKEN", app = ""))
    }

    @Test
    fun saysWhenItCouldNotAsk() {
        assertEquals("Couldn’t reach $OWN to check this link. Try again.", SignInLink.unreachable(OWN))
    }

    @Test
    fun saysWhoseLinkItIs() {
        assertEquals(
            "This link is for https://b.example.test. This app signs in to $OWN.",
            SignInLink.wrongServer("https://b.example.test", OWN)
        )
    }
}

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScoreboardDeskSignInLinkTest {
    private class Account(var issuer: String? = "https://web.example.test/oauth") : ScoreboardAccount {
        /** Discovery cannot be reached at all. */
        var down = false
        val startedWith = ArrayList<String?>()
        val spent = ArrayList<Pair<String, String>>()
        override fun startSignIn(server: String, email: String, origin: String, appOrigin: String?): ScoreboardSignInStarted {
            startedWith += appOrigin
            return ScoreboardSignInStarted("r", "s")
        }
        override fun completeSignIn(server: String, email: String, code: String, deviceName: String) =
            error("not used")
        override fun signInWithLink(server: String, token: String, deviceName: String): ScoreboardSignedIn {
            spent += token to deviceName
            return ScoreboardSignedIn("session", "Ken Griffey", "griffey@example.test", "1001")
        }
        override fun issuer(server: String): String? = if (down) throw IOException("no route") else issuer
        override fun events(server: String, token: String, zone: ZoneId) = ScoreboardEventLists(emptyList(), emptyList())
        override fun me(server: String, token: String) = "1001"
        override fun eventControlKey(server: String, token: String) = error("not used")
    }

    private class Quiet : ScoreboardPublisher {
        override fun send(target: ScoreboardSocketTarget?, text: String) = Unit
        override fun close() = Unit
    }

    private fun TestScope.desk(account: Account, appOrigin: String = APP) = ScoreboardDesk(
        store = InMemorySettingsStore(),
        scope = backgroundScope,
        account = account,
        liveSocket = Quiet(),
        zone = ZoneId.of("UTC"),
        appOrigin = appOrigin,
        accountOrigin = OWN,
        io = UnconfinedTestDispatcher(testScheduler)
    )

    @Test
    fun asksForTheLinkToComeToTheAppsHost() = runTest(UnconfinedTestDispatcher()) {
        val account = Account()
        desk(account).sendCode("griffey@example.test")
        desk(account, appOrigin = "").sendCode("griffey@example.test")
        runCurrent()
        assertEquals(listOf(APP, null), account.startedWith)
    }

    @Test
    fun signsInWithItsOwnLink() = runTest(UnconfinedTestDispatcher()) {
        val account = Account()
        val board = desk(account)
        assertTrue(board.signIn("$APP/signin/$TOKEN"))
        runCurrent()
        assertEquals(listOf(TOKEN to "TS Cameraman"), account.spent)
        assertTrue(board.state.value.signedIn)
        assertEquals("Signed in to TeamStation as Ken Griffey", board.state.value.status)
        assertEquals("Signed in to TeamStation as Ken Griffey", board.state.value.linkMessage)
    }

    @Test
    fun signsInWhenAnotherNameIsItsServersIssuer() = runTest(UnconfinedTestDispatcher()) {
        val account = Account()
        val board = desk(account)
        assertTrue(board.signIn("$APP/signin/$TOKEN?server=https%3A%2F%2Fweb.example.test"))
        runCurrent()
        assertEquals(1, account.spent.size)
    }

    @Test
    fun neverSendsAnotherServersToken() = runTest(UnconfinedTestDispatcher()) {
        val account = Account()
        val board = desk(account)
        assertTrue(board.signIn("$APP/signin/$TOKEN?server=https%3A%2F%2Fseat.example.test"))
        runCurrent()
        assertTrue(account.spent.isEmpty())
        assertFalse(board.state.value.signedIn)
        assertEquals("This link is for https://seat.example.test. This app signs in to $OWN.", board.state.value.status)
    }

    @Test
    fun callsALinkAnotherServersWhenItsServerNamesNoIssuer() = runTest(UnconfinedTestDispatcher()) {
        val account = Account(issuer = null)
        val board = desk(account)
        assertTrue(board.signIn("$APP/signin/$TOKEN?server=https%3A%2F%2Fweb.example.test"))
        runCurrent()
        assertTrue(account.spent.isEmpty())
        assertEquals("This link is for https://web.example.test. This app signs in to $OWN.", board.state.value.status)
    }

    @Test
    fun saysWhenItCouldNotAskItsServer() = runTest(UnconfinedTestDispatcher()) {
        val account = Account().apply { down = true }
        val board = desk(account)
        assertTrue(board.signIn("$APP/signin/$TOKEN?server=https%3A%2F%2Fweb.example.test"))
        runCurrent()
        assertTrue(account.spent.isEmpty())
        assertFalse(board.state.value.signedIn)
        assertEquals("Couldn’t reach $OWN to check this link. Try again.", board.state.value.status)
        assertEquals(board.state.value.status, board.state.value.linkMessage)
    }

    @Test
    fun saysWhatALinkDidOverTheScreenForAFewSeconds() = runTest(UnconfinedTestDispatcher()) {
        val board = desk(Account())
        board.signIn("$APP/signin/$TOKEN?server=https%3A%2F%2Fseat.example.test")
        runCurrent()
        val wrong = "This link is for https://seat.example.test. This app signs in to $OWN."
        assertEquals(wrong, board.state.value.linkMessage)
        advanceTimeBy(ScoreboardDesk.LINK_MESSAGE_MS - 1)
        runCurrent()
        assertEquals(wrong, board.state.value.linkMessage)

        // A second link restarts the clock with its own outcome.
        board.signIn("$APP/signin/$TOKEN")
        runCurrent()
        assertEquals("Signed in to TeamStation as Ken Griffey", board.state.value.linkMessage)
        advanceTimeBy(ScoreboardDesk.LINK_MESSAGE_MS - 1)
        runCurrent()
        assertEquals("Signed in to TeamStation as Ken Griffey", board.state.value.linkMessage)
        advanceTimeBy(2)
        runCurrent()
        assertEquals("", board.state.value.linkMessage)
        assertEquals("Signed in to TeamStation as Ken Griffey", board.state.value.status)
    }

    @Test
    fun leavesOtherAddressesAlone() = runTest(UnconfinedTestDispatcher()) {
        val account = Account()
        assertFalse(desk(account).signIn("https://other.example.test/signin/$TOKEN"))
        runCurrent()
        assertTrue(account.spent.isEmpty())
    }
}

/** The activity's hand-off of a link intent to the desk. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SpendSignInIntentTest {
    private val link = "$APP/signin/$TOKEN"

    @Test
    fun handsAnHttpsViewToTheDeskAndForgetsItOnceTaken() {
        val handed = ArrayList<String>()
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
        assertTrue(spendSignInIntent(intent) { handed += it; true })
        assertEquals(listOf(link), handed)
        assertNull(intent.data)
        assertFalse(spendSignInIntent(intent) { handed += it; true })
        assertEquals(1, handed.size)
    }

    @Test
    fun leavesALinkReplayedFromRecentsAlone() {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(link))
            .addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY)
        assertFalse(spendSignInIntent(intent) { error("spent again: $it") })
        assertEquals(link, intent.data.toString())
    }

    @Test
    fun keepsAnAddressTheDeskDidNotTake() {
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("$APP/games/g1"))
        assertFalse(spendSignInIntent(intent) { false })
        assertEquals("$APP/games/g1", intent.data.toString())
    }

    @Test
    fun leavesOtherIntentsAlone() {
        val never: (String) -> Boolean = { error("not a sign-in: $it") }
        assertFalse(spendSignInIntent(null, never))
        assertFalse(spendSignInIntent(Intent(Intent.ACTION_MAIN), never))
        assertFalse(spendSignInIntent(Intent(Intent.ACTION_VIEW), never))
        assertFalse(spendSignInIntent(Intent(Intent.ACTION_VIEW, Uri.parse("tscameraman://test/x")), never))
    }
}

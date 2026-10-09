package app.teamstation.cameraman.sentry

import android.content.Intent
import io.sentry.Breadcrumb
import io.sentry.Sentry
import io.sentry.SentryEvent
import io.sentry.protocol.Message
import io.sentry.protocol.Request
import io.sentry.protocol.SentryException
import io.sentry.protocol.User
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class SentrySetupTest {
    @Test
    fun `a build without a DSN starts nothing`() {
        SentrySetup.start(RuntimeEnvironment.getApplication(), dsn = "")
        assertFalse(Sentry.isEnabled())
    }

    @Test
    fun `an event leaves with no credential, server name or personal detail`() {
        val event = SentryEvent().apply {
            message = Message().apply { formatted = "code for ruth@example.test" }
            transaction = "POST /api/v1/join/INVITE42/redeem"
            contexts.put("session", mapOf("token" to "t"))
            contexts.put("upload", mapOf("token" to "t", "bytes" to 4))
            exceptions = listOf(SentryException().apply { value = "GET /i/abc" })
            request = Request().apply {
                url = "https://app.example.test/api/v1/auth/password?x=1"
                cookies = "ts_session=s"
                queryString = "x=1"
                headers = mapOf("Authorization" to "Bearer t", "User-Agent" to "ua")
            }
            serverName = "workstation.example.test"
            user = User().apply { id = "7"; email = "ruth@example.test" }
            setExtra("token", "t")
            setExtra("count", 3)
            breadcrumbs = listOf(
                Breadcrumb().apply { category = "console"; message = "code 123456" },
                Breadcrumb().apply { category = "ui.click"; message = "/signin/abc" },
            )
        }
        val out = SentrySetup.scrub(event)
        assertEquals("code for [email]", out.message?.formatted)
        assertEquals("POST /api/v1/join/[Filtered]/redeem", out.transaction)
        assertNull(out.contexts.get("session"))
        assertEquals(mapOf("token" to SentryRules.FILTERED, "bytes" to 4), out.contexts.get("upload"))
        assertEquals("GET /i/[Filtered]", out.exceptions?.first()?.value)
        assertEquals("https://app.example.test/api/v1/auth/password", out.request?.url)
        assertNull(out.request?.cookies)
        assertNull(out.request?.queryString)
        assertEquals(mapOf("User-Agent" to "ua"), out.request?.headers)
        assertNull(out.serverName)
        assertEquals("7", out.user?.id)
        assertNull(out.user?.email)
        assertEquals(SentryRules.FILTERED, out.getExtra("token"))
        assertEquals(3, out.getExtra("count"))
        assertEquals(listOf("/signin/[Filtered]"), out.breadcrumbs?.map { it.message })
    }

    @Test
    fun `an event without a user or request stays without one`() {
        val out = SentrySetup.scrub(SentryEvent().apply { user = User().apply { email = "e@example.test" } })
        assertNull(out.user)
        assertNull(out.request)
    }

    @Test
    fun `a crash test crashes once, on a fresh launch of a test build only`() {
        var crashes = 0
        SentrySetup.handleTest(null, null, enabled = true) { crashes++ }
        SentrySetup.handleTest(Intent(), null, enabled = true) { crashes++ }
        val launch = Intent().putExtra("sentryTest", "crash")
        SentrySetup.handleTest(launch, null, enabled = false) { crashes++ }
        SentrySetup.handleTest(launch, Any(), enabled = true) { crashes++ }
        assertEquals(0, crashes)
        SentrySetup.handleTest(launch, null, enabled = true) { crashes++ }
        SentrySetup.handleTest(launch, null, enabled = true) { crashes++ }
        assertEquals(1, crashes)
        assertNull(launch.getStringExtra("sentryTest"))
    }

    @Test
    fun `a shipped build ignores the test extra`() {
        var crashes = 0
        SentrySetup.handleTest(Intent().putExtra("sentryTest", "crash"), null) { crashes++ }
        assertEquals(0, crashes)
    }

    @Test
    fun `a build with a DSN reports through the rules, with its release and environment`() {
        val sent = mutableListOf<SentryEvent>()
        SentrySetup.start(RuntimeEnvironment.getApplication(), dsn = "https://0123456789abcdef@sentry.example.test/1") { options ->
            options.isEnableNdk = false
            // Record what the rules let through, instead of sending it anywhere.
            val rules = options.beforeSend
            options.setBeforeSend { event, hint ->
                rules?.execute(event, hint)?.also { sent.add(it) }
                null
            }
        }
        try {
            assertTrue(Sentry.isEnabled())
            assertEquals("app.teamstation.cameraman@1.0+1", Sentry.getCurrentScopes().options.release)
            assertEquals("production", Sentry.getCurrentScopes().options.environment)
            Sentry.addBreadcrumb(Breadcrumb().apply { category = "console"; message = "code 123456" })
            Sentry.addBreadcrumb(
                Breadcrumb().apply {
                    category = "http"
                    message = "/signin/abc"
                    setData("url", "/api/v1/teams?token=1")
                    setData("token", "t")
                }
            )
            SentrySetup.handleTest(Intent().putExtra("sentryTest", "error"), null, enabled = true) {}
            Sentry.flush(2000)
            assertEquals(1, sent.size)
            val event = sent.first()
            assertEquals("Sentry test error", event.exceptions?.first()?.value)
            val crumbs = event.breadcrumbs.orEmpty().filter { it.category == "http" }
            assertEquals("/signin/[Filtered]", crumbs.single().message)
            assertEquals("/api/v1/teams", crumbs.single().getData("url"))
            assertEquals(SentryRules.FILTERED, crumbs.single().getData("token"))
            assertTrue(event.breadcrumbs.orEmpty().none { it.category == "console" })
        } finally {
            Sentry.close()
        }
    }
}

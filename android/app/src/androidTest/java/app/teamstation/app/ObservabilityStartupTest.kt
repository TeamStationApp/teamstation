package app.teamstation.app

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.media3.common.MediaItem
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.exoplayer.hls.HlsMediaSource
import app.teamstation.app.video.LivePlaylistPatience
import com.brentvatne.common.api.Source
import io.sentry.Hint
import io.sentry.Sentry
import io.sentry.SentryEvent
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** The real host must install native privacy callbacks before React Native starts. */
@RunWith(AndroidJUnit4::class)
class ObservabilityStartupTest {
    @Test fun hlsTrackerMatchesTheRuntimeMediaInterface() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val dataSource = DefaultDataSource.Factory(context)
        val factory = LivePlaylistPatience.overrideMediaSourceFactory(
            Source(), HlsMediaSource.Factory(dataSource), dataSource
        )!!
        // Constructing the real source invokes our tracker factory, catching binary API mismatches.
        val source = factory.createMediaSource(MediaItem.fromUri("https://media.example.test/fixture.m3u8"))
        assertNotNull(source)
        assertEquals(540_000L, LivePlaylistPatience.stuckAfterMs(2_000))
    }
    @Test fun hostInitializesNativeCrashPrivacy() {
        val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext
        assertTrue(app is MainApplication)
        assertTrue("Build with a test collector DSN", Sentry.isEnabled())
        val options = Sentry.getCurrentScopes().options
        assertFalse(options.isSendDefaultPii)
        assertEquals(0, options.maxBreadcrumbs)
        val callback = requireNotNull(options.beforeSend)
        val raw = SentryEvent().apply {
            setExtra("chat", "private-canary")
            serverName = "private-canary"
        }
        val clean = requireNotNull(callback.execute(raw, Hint()))
        assertNull(clean.extras)
        assertNull(clean.serverName)
        assertEquals("internal", clean.exceptions?.single()?.value)
    }
}

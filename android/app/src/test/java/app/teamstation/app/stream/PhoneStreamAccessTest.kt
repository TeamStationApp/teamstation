package app.teamstation.app.stream

import app.teamstation.streamcore.phonestream.PhoneStreamError
import app.teamstation.streamcore.phonestream.PhoneStreamException
import kotlinx.coroutines.CancellationException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.fail
import org.junit.Test

/** An engine that cannot be made leaves the app running: unsupported, and every call refused. */
class PhoneStreamAccessTest {
    @Test
    fun anEngineThatCannotBeMadeIsUnsupportedAndEveryCallRefusesWithWhy() {
        val once = EngineOnce<Any>()
        var tries = 0
        val make = {
            tries += 1
            throw RuntimeException("database or disk is full (code 13 SQLITE_FULL)")
        }
        assertNull(once.getOrNull(make))
        repeat(2) {
            try {
                once.get(make)
                fail("an engine that could not be made was handed out")
            } catch (error: PhoneStreamUnavailable) {
                assertEquals("Phone streaming could not start: database or disk is full (code 13 SQLITE_FULL)", error.reason)
                assertEquals("unsupported" to error.reason, PhoneStreamRefusal.of(error))
            }
        }
        // Tried once, not at every call.
        assertEquals(1, tries)
    }

    @Test
    fun anEngineThatOpensIsMadeOnce() {
        val once = EngineOnce<Any>()
        val engine = Any()
        var tries = 0
        assertSame(engine, once.get { tries += 1; engine })
        assertSame(engine, once.getOrNull { tries += 1; Any() })
        assertEquals(1, tries)
    }

    @Test
    fun everyOtherRefusalKeepsItsCode() {
        assertEquals("uploadInProgress" to "uploadInProgress", PhoneStreamRefusal.of(PhoneStreamException(PhoneStreamError.UPLOAD_IN_PROGRESS)))
        assertEquals("cancelled" to "cancelled", PhoneStreamRefusal.of(CancellationException("gone")))
        assertEquals("failed" to "boom", PhoneStreamRefusal.of(IllegalStateException("boom")))
        assertEquals("failed" to "IllegalStateException", PhoneStreamRefusal.of(IllegalStateException()))
    }
}

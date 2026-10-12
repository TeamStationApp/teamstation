package app.teamstation.cameraman

import app.teamstation.cameraman.core.BroadcastPolicy
import app.teamstation.cameraman.core.BroadcastPreference
import app.teamstation.streamcore.core.InMemorySettingsStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BroadcastPolicyTest {
    @Test
    fun `an ordinary launch stays quiet until the operator has broadcast`() {
        assertFalse(BroadcastPolicy.shouldListen(saved = false, isUITest = false, selfTest = false, recordSeconds = 0.0))
        assertTrue(BroadcastPolicy.shouldListen(saved = true, isUITest = false, selfTest = false, recordSeconds = 0.0))
    }

    @Test
    fun `a harness that needs a listener does not consult or replace the saved choice`() {
        assertTrue(BroadcastPolicy.shouldListen(saved = false, isUITest = true, selfTest = false, recordSeconds = 0.0))
        assertTrue(BroadcastPolicy.shouldListen(saved = false, isUITest = false, selfTest = true, recordSeconds = 0.0))
        assertFalse(BroadcastPolicy.shouldPersist(persistSettings = true, isUITest = true, selfTest = false))
        assertFalse(BroadcastPolicy.shouldPersist(persistSettings = true, isUITest = false, selfTest = true))
        assertTrue(BroadcastPolicy.shouldPersist(persistSettings = true, isUITest = false, selfTest = false))
        assertFalse(BroadcastPolicy.shouldPersist(persistSettings = false, isUITest = false, selfTest = false))
    }

    @Test
    fun `a recording run leaves the port free`() {
        assertFalse(BroadcastPolicy.shouldListen(saved = true, isUITest = true, selfTest = true, recordSeconds = 5.0))
    }

    @Test
    fun `the service outlives the activity only while broadcasting`() {
        assertFalse(BroadcastPolicy.shouldStopService(activityVisible = true, broadcasting = false))
        assertFalse(BroadcastPolicy.shouldStopService(activityVisible = true, broadcasting = true))
        assertTrue(BroadcastPolicy.shouldStopService(activityVisible = false, broadcasting = false))
        assertFalse(BroadcastPolicy.shouldStopService(activityVisible = false, broadcasting = true))
        assertFalse(BroadcastPolicy.keepProcessAlive(false))
        assertTrue(BroadcastPolicy.keepProcessAlive(true))
    }

    @Test
    fun `the stop slider commits at eighty percent`() {
        assertFalse(BroadcastPolicy.slideCommits(0.79))
        assertTrue(BroadcastPolicy.slideCommits(0.8))
        assertTrue(BroadcastPolicy.slideCommits(1.0))
    }

    @Test
    fun `the saved choice round trips and defaults to quiet`() {
        val store = InMemorySettingsStore()
        val preference = BroadcastPreference(store)
        assertFalse(preference.load())
        preference.save(true)
        assertEquals("true", store.string(BroadcastPolicy.preferenceKey))
        assertTrue(BroadcastPreference(store).load())
        preference.save(false)
        assertFalse(preference.load())
    }
}

package app.teamstation.streamcore.radar

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
class PreferencesRadarPairingStoreTest {
    @Test
    fun `the paired serial and the enabled switch persist, and a cleared pairing reads as none`() {
        val context = RuntimeEnvironment.getApplication()
        val store = PreferencesRadarPairingStore(context)
        assertNull(store.read())
        assertTrue(store.readEnabled())

        store.write("ADFA0000001")
        store.writeEnabled(false)
        val reopened = PreferencesRadarPairingStore(context)
        assertEquals("ADFA0000001", reopened.read())
        assertFalse(reopened.readEnabled())

        reopened.write(null)
        assertNull(PreferencesRadarPairingStore(context).read())
    }

    @Test
    fun `radar permissions follow the running release`() {
        assertEquals(RadarPermissions.required(34), RadarPermissions.required())
    }
}

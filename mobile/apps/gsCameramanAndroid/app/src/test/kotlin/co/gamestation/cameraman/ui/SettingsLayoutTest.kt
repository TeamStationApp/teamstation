package co.gamestation.cameraman.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class SettingsLayoutTest {
    @Test
    fun `portrait phones and tablets stack, landscape keeps two columns`() {
        assertEquals(1, SettingsLayout.columns(390, 844))
        assertEquals(2, SettingsLayout.columns(844, 390))
        assertEquals(1, SettingsLayout.columns(768, 1024))
        assertEquals(2, SettingsLayout.columns(1024, 768))
        assertEquals(1, SettingsLayout.columns(560, 320))
        assertEquals(2, SettingsLayout.columns(600, 320))
    }
}

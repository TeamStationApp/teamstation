package co.gamestation.cameraman.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.displayCutout
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

/**
 * The settings screen is one vertical scroll with two top-aligned columns inside it.
 *
 * Horizontal cutout and safe-drawing insets sit outside the 14dp content padding, so a punch-hole
 * on either side of a landscape phone does not cover the cards. The top inset is the scaffold's:
 * this column does not take it.
 */
@Composable
fun SettingsBody(
    modifier: Modifier = Modifier,
    columns: Int = 2,
    horizontalInsets: WindowInsets = WindowInsets.displayCutout
        .union(WindowInsets.safeDrawing)
        .only(androidx.compose.foundation.layout.WindowInsetsSides.Horizontal),
    header: @Composable ColumnScope.() -> Unit = {},
    left: @Composable ColumnScope.() -> Unit = {},
    right: @Composable ColumnScope.() -> Unit = {},
    stack: @Composable ColumnScope.() -> Unit = {},
    footer: @Composable ColumnScope.() -> Unit = {}
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .windowInsetsPadding(horizontalInsets)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 14.dp, vertical = 4.dp)
            .testTag("settings-scroll")
    ) {
        header()
        if (columns == 1) {
            Column(
                verticalArrangement = Arrangement.spacedBy(16.dp),
                modifier = Modifier.testTag("settings-layout-portrait"),
                content = stack
            )
        } else {
            Row(
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalAlignment = Alignment.Top,
                modifier = Modifier.testTag("settings-layout-landscape")
            ) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                    content = left
                )
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(16.dp),
                    content = right
                )
            }
        }
        footer()
    }
}

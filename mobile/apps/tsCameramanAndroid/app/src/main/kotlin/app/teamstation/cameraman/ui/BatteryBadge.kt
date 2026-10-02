package app.teamstation.cameraman.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.teamstation.cameraman.core.BatteryStatus
import app.teamstation.cameraman.ui.theme.CameramanTokens

/**
 * The battery pill: a green slab with a nub on the right so it reads as a battery at a glance,
 * the percentage in white on top, turning the low-power yellow under 20 %.
 *
 * Drawn rather than assembled from a `Surface` and an `Icon`, because the nub has to sit outside the
 * slab and no shape in the library has one. Sized to match the thermal pill beside it.
 *
 * Untappable, like the thermal pill: on the operating screen a zoom drag has to reach the preview.
 */
@Composable
fun BatteryBadge(status: BatteryStatus, modifier: Modifier = Modifier) {
    val colour = Color(
        red = status.hue.red.toFloat(),
        green = status.hue.green.toFloat(),
        blue = status.hue.blue.toFloat()
    )

    Row(
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            // The height every chrome pill shares, so this lands on the same line as the camera name.
            .height(CameramanTokens.chromePillHeight)
            // The nub's width is reserved on the trailing edge so a neighbouring pill cannot
            // overlap it.
            .padding(end = nubWidth + 1.dp)
            .drawBehind { drawBattery(colour) }
            .padding(horizontal = 14.dp)
            .semantics { contentDescription = "Battery ${status.label}" }
            .testTag("camera-battery")
    ) {
        if (status.isCharging) {
            Icon(
                imageVector = Icons.Filled.Bolt,
                contentDescription = null,
                tint = Color.White,
                modifier = Modifier.padding(end = 0.dp)
            )
        }
        Text(
            text = status.label,
            color = Color.White,
            fontSize = 13.sp,
            fontWeight = FontWeight.Black,
            letterSpacing = 1.sp,
            // Monospaced digits so the pill does not twitch as the percentage counts down.
            fontFamily = FontFamily.Monospace
        )
    }
}

private val nubWidth = 4.dp

private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawBattery(colour: Color) {
    val nub = nubWidth.toPx()
    val gap = 1.dp.toPx()
    val bodyWidth = (size.width - nub - gap).coerceAtLeast(0f)

    drawRoundRect(
        color = colour,
        size = Size(bodyWidth, size.height),
        cornerRadius = CornerRadius(8.dp.toPx())
    )

    val nubHeight = size.height * 0.42f
    drawRoundRect(
        color = colour,
        topLeft = Offset(bodyWidth + gap, (size.height - nubHeight) / 2f),
        size = Size(nub, nubHeight),
        cornerRadius = CornerRadius(minOf(nub / 2f, 2.dp.toPx()))
    )
}

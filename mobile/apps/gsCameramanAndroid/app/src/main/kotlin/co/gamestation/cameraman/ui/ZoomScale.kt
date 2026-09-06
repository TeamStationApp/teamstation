package co.gamestation.cameraman.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import co.gamestation.cameraman.core.ZoomMapping
import co.gamestation.cameraman.ui.theme.CameramanTokens
import co.gamestation.cameraman.ui.theme.MonospaceLabel

/**
 * Vertical zoom column: widest at the bottom, tightest at the top, ticks between the pills.
 *
 * The pills are `Surface`es rather than buttons so the selected one can take `primary` / `onPrimary`
 * — the M3 role pair for a chosen item — while the rest sit on the scrim like the other chrome.
 * Spacing is derived from the available height so the stack always fits, and the pill-to-pill gap is
 * reported back so a full-screen drag walks the same distance the drawn scale does.
 */
@Composable
fun ZoomScale(
    mapping: ZoomMapping,
    displayedZoom: Double,
    onSelect: (Double) -> Unit,
    onSegmentLength: (Float) -> Unit,
    modifier: Modifier = Modifier
) {
    val presets = mapping.presetDisplayedZooms
    val highlight = mapping.scaleHighlight(displayedZoom)
    val density = LocalDensity.current
    var spacing by remember { mutableStateOf(10.dp) }

    Column(
        modifier = modifier.width(52.dp).testTag("zoom-scale"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxHeight()
                .onSizeChanged { size ->
                    val heightDp = with(density) { size.height.toDp() }
                    spacing = segmentSpacing(heightDp, presets.size)
                    // One pill plus one run of ticks and the gaps around them is the centre-to-centre
                    // distance a drag has to cover to walk from one lens to the next.
                    val segment = pillSize + spacing * (ZoomMapping.scaleTicksPerSegment + 1) +
                        tickThickness * ZoomMapping.scaleTicksPerSegment
                    onSegmentLength(with(density) { segment.toPx() })
                },
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            // Drawn tightest-first so the widest lens sits at the bottom, the way a camera app does.
            for (index in presets.indices.reversed()) {
                PresetPill(presets[index], highlight, onSelect)
                if (index > 0) {
                    TickStack(segment = index - 1, highlight = highlight, spacing = spacing)
                }
            }
        }

        ZoomReadout(displayedZoom)
    }
}

@Composable
private fun ZoomReadout(displayedZoom: Double) {
    Surface(
        shape = MaterialTheme.shapes.small,
        color = MaterialTheme.colorScheme.scrim.copy(alpha = CameramanTokens.chromeScrimAlpha),
        contentColor = MaterialTheme.colorScheme.onSurface
    ) {
        Text(
            text = ZoomMapping.label(displayedZoom),
            style = MonospaceLabel,
            modifier = Modifier
                .padding(horizontal = 8.dp, vertical = 5.dp)
                .testTag("zoom-label")
        )
    }
}

@Composable
private fun PresetPill(
    preset: Double,
    highlight: ZoomMapping.ScaleHighlight,
    onSelect: (Double) -> Unit
) {
    val isActive = highlight == ZoomMapping.ScaleHighlight.Preset(preset)
    val label = ZoomMapping.label(preset)

    // Animated so a pinch that walks past a lens reads as a handover rather than a flicker.
    val container by animateColorAsState(
        targetValue = if (isActive) {
            MaterialTheme.colorScheme.primary
        } else {
            MaterialTheme.colorScheme.scrim.copy(alpha = CameramanTokens.chromeScrimAlpha)
        },
        label = "zoom-pill-container"
    )
    val content by animateColorAsState(
        targetValue = if (isActive) {
            MaterialTheme.colorScheme.onPrimary
        } else {
            MaterialTheme.colorScheme.onSurface
        },
        label = "zoom-pill-content"
    )

    Surface(
        onClick = { onSelect(preset) },
        shape = CircleShape,
        color = container,
        contentColor = content,
        modifier = Modifier
            .size(pillSize)
            .testTag("zoom-preset-$label")
            .semantics { contentDescription = label }
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(text = label, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun TickStack(segment: Int, highlight: ZoomMapping.ScaleHighlight, spacing: Dp) {
    Column(
        modifier = Modifier.padding(vertical = spacing),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(spacing)
    ) {
        for (index in (ZoomMapping.scaleTicksPerSegment - 1) downTo 0) {
            Tick(isActive = highlight == ZoomMapping.ScaleHighlight.Tick(segment, index), segment, index)
        }
    }
}

@Composable
private fun Tick(isActive: Boolean, segment: Int, index: Int) {
    val width by animateDpAsState(
        targetValue = if (isActive) 24.dp else 16.dp,
        label = "zoom-tick-width"
    )
    val colour by animateColorAsState(
        targetValue = if (isActive) {
            MaterialTheme.colorScheme.primary
        } else {
            MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = CameramanTokens.subtleScrimAlpha)
        },
        label = "zoom-tick-colour"
    )
    Box(
        modifier = Modifier
            .width(width)
            .height(tickThickness)
            .background(colour, CircleShape)
            .testTag("zoom-tick-$segment-$index")
    )
}

private val pillSize = 46.dp
private val tickThickness = 3.dp

/**
 * Fits n pills and the ticks between them into [height]. Matches a 10dp gap when there is room and
 * shrinks uniformly when there is not.
 */
private fun segmentSpacing(height: Dp, presetCount: Int): Dp {
    val buttons = maxOf(presetCount, 1)
    val segments = maxOf(buttons - 1, 1)
    val ticks = ZoomMapping.scaleTicksPerSegment
    val leftover = height - pillSize * buttons - tickThickness * (segments * ticks)
    val gaps = segments * (ticks + 1)
    val raw = if (gaps > 0) leftover / gaps else 10.dp
    return raw.coerceIn(2.dp, 10.dp)
}

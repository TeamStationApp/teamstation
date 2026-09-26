package co.gamestation.cameraman.ui

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import co.gamestation.cameraman.core.ZoomMapping
import co.gamestation.cameraman.ui.theme.CameramanTokens
import kotlin.math.abs

/**
 * Vertical zoom column: widest at the bottom, tightest at the top, ticks between the pills.
 *
 * The rail fills the height below the badges, and the ticks share the leftover space equally, so the
 * first and last stops sit on the same span whether the camera offers two lenses or five. **The live
 * readout sits to the left of the pills, vertically centred** — not under them, where it reads as a
 * caption for the bottom pill rather than as the current value of the whole rail.
 *
 * Adjacent pill centres are reported back so a full-screen drag walks the same distance the drawn
 * scale does.
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

    Row(
        modifier = modifier.testTag("zoom-scale"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(labelGap)
    ) {
        Text(
            text = ZoomMapping.label(displayedZoom),
            color = if (mapping.isSoftwareZoom(displayedZoom)) softwareZoomColour else MaterialTheme.colorScheme.onSurface,
            fontFamily = FontFamily.Monospace,
            fontWeight = FontWeight.SemiBold,
            fontSize = 11.sp,
            textAlign = TextAlign.End,
            modifier = Modifier
                .widthIn(min = 30.dp)
                .background(
                    MaterialTheme.colorScheme.scrim.copy(alpha = CameramanTokens.subtleScrimAlpha),
                    MaterialTheme.shapes.extraSmall
                )
                .testTag("zoom-label")
        )

        Rail(
            mapping = mapping,
            presets = presets,
            highlight = highlight,
            onSelect = onSelect,
            onSegmentLength = { pixels -> onSegmentLength(pixels) },
            density = density,
            modifier = Modifier
                .width(pillSize)
                .fillMaxHeight()
        )
    }
}

@Composable
private fun Rail(
    mapping: ZoomMapping,
    presets: List<Double>,
    highlight: ZoomMapping.ScaleHighlight,
    onSelect: (Double) -> Unit,
    onSegmentLength: (Float) -> Unit,
    density: androidx.compose.ui.unit.Density,
    modifier: Modifier = Modifier
) {
    // Pill centres in the rail's own coordinates, so the reported gap is what is drawn rather than
    // what was intended.
    val centres = remember { mutableMapOf<Int, Float>() }
    var railTop by remember { mutableFloatStateOf(0f) }

    Column(
        modifier = modifier.onGloballyPositioned { railTop = it.positionInWindow().y },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = if (presets.size <= 1) Arrangement.Center else Arrangement.Top
    ) {
        if (presets.size <= 1) {
            presets.firstOrNull()?.let { PresetPill(it, mapping.isSoftwareZoom(it), highlight, onSelect) }
            return@Column
        }

        // Drawn tightest-first so the widest lens sits at the bottom, the way a camera app does.
        for (index in presets.indices.reversed()) {
            PresetPill(
                preset = presets[index],
                isSoftware = mapping.isSoftwareZoom(presets[index]),
                highlight = highlight,
                onSelect = onSelect,
                modifier = Modifier.onGloballyPositioned { coordinates ->
                    val centre = coordinates.positionInWindow().y - railTop +
                        coordinates.size.height / 2f
                    if (centres[index] != centre) {
                        centres[index] = centre
                        segmentLength(centres)?.let(onSegmentLength)
                    }
                }
            )
            if (index > 0) {
                TickStack(
                    segment = index - 1,
                    isSoftware = mapping.isSoftwareSegment(index - 1),
                    highlight = highlight,
                    modifier = Modifier.weight(1f)
                )
            }
        }
    }
}

/** The mean gap between adjacent pill centres, which is one segment of the scale. */
private fun segmentLength(centres: Map<Int, Float>): Float? {
    val ordered = centres.keys.sorted().mapNotNull { centres[it] }
    if (ordered.size < 2) return null
    var total = 0f
    for (index in 1 until ordered.size) total += abs(ordered[index] - ordered[index - 1])
    val mean = total / (ordered.size - 1)
    return if (mean > 0) mean else null
}

@Composable
private fun PresetPill(
    preset: Double,
    isSoftware: Boolean,
    highlight: ZoomMapping.ScaleHighlight,
    onSelect: (Double) -> Unit,
    modifier: Modifier = Modifier
) {
    val isActive = highlight == ZoomMapping.ScaleHighlight.Preset(preset)
    val label = ZoomMapping.label(preset)

    // Animated so a pinch that walks past a lens reads as a handover rather than a flicker.
    val container by animateColorAsState(
        targetValue = if (isActive) {
            if (isSoftware) softwareZoomColour else MaterialTheme.colorScheme.primary
        } else {
            MaterialTheme.colorScheme.scrim.copy(alpha = CameramanTokens.chromeScrimAlpha)
        },
        label = "zoom-pill-container"
    )
    val content by animateColorAsState(
        targetValue = if (isActive) {
            if (isSoftware) Color.Black else MaterialTheme.colorScheme.onPrimary
        } else {
            if (isSoftware) softwareZoomColour else MaterialTheme.colorScheme.onSurface
        },
        label = "zoom-pill-content"
    )

    Surface(
        onClick = { onSelect(preset) },
        shape = CircleShape,
        color = container,
        contentColor = content,
        modifier = modifier
            .size(pillSize)
            .testTag("zoom-preset-$label")
            .semantics { contentDescription = label }
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(
                text = label,
                fontSize = 11.sp,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}

/**
 * The ticks for one segment, sharing the leftover height equally.
 *
 * Spacers rather than a computed gap: the rail has to fill whatever height the badges above it leave,
 * and a camera with two lenses has to pin its first and last pills to the same edges as one with
 * five.
 */
@Composable
private fun TickStack(
    segment: Int,
    isSoftware: Boolean,
    highlight: ZoomMapping.ScaleHighlight,
    modifier: Modifier
) {
    Column(
        modifier = modifier,
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Spacer(Modifier.weight(1f))
        for (index in (ZoomMapping.scaleTicksPerSegment - 1) downTo 0) {
            Tick(
                isActive = highlight == ZoomMapping.ScaleHighlight.Tick(segment, index),
                isSoftware = isSoftware,
                segment = segment,
                index = index
            )
            Spacer(Modifier.weight(1f))
        }
    }
}

@Composable
private fun Tick(isActive: Boolean, isSoftware: Boolean, segment: Int, index: Int) {
    val width by animateDpAsState(
        targetValue = if (isActive) 14.dp else 10.dp,
        label = "zoom-tick-width"
    )
    val colour by animateColorAsState(
        targetValue = when {
            isSoftware && isActive -> softwareZoomColour
            isSoftware -> softwareZoomColour.copy(alpha = 0.38f)
            isActive -> MaterialTheme.colorScheme.primary
            else -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.38f)
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

private val pillSize = 32.dp
private val tickThickness = 2.dp
private val labelGap = 6.dp

/** Zoom past the camera's own ceiling is Cameraman's software zoom, drawn in yellow as on iOS. */
private val softwareZoomColour = Color(0xFFFFD60A)

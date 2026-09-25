package io.sublab.client.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** Палитра: почти чёрный фон, приглушённые поверхности и фиолетово-бирюзовый акцент. */
object Palette {
    val Background = Color(0xFF07080D)
    val Surface = Color(0xFF10121A)
    val SurfaceHigh = Color(0xFF171A25)
    val SurfaceHighest = Color(0xFF1F2331)
    val Stroke = Color(0xFF252A3A)
    val TextPrimary = Color(0xFFF2F3F7)
    val TextSecondary = Color(0xFF8A90A6)
    val TextMuted = Color(0xFF585E73)
    val Violet = Color(0xFF7C5CFF)
    val VioletSoft = Color(0xFF9B7BFF)
    val Cyan = Color(0xFF36D1DC)
    val Green = Color(0xFF3DDC97)
    val Amber = Color(0xFFFFB547)
    val Red = Color(0xFFFF5C7A)

    val Accent = Brush.linearGradient(listOf(VioletSoft, Violet, Cyan))
    val Connected = Brush.linearGradient(listOf(Color(0xFF2BD99F), Cyan))
}

private val colors = darkColorScheme(
    primary = Palette.Violet,
    onPrimary = Color.White,
    primaryContainer = Palette.SurfaceHighest,
    onPrimaryContainer = Palette.TextPrimary,
    secondary = Palette.Cyan,
    onSecondary = Palette.Background,
    background = Palette.Background,
    onBackground = Palette.TextPrimary,
    surface = Palette.Surface,
    onSurface = Palette.TextPrimary,
    surfaceVariant = Palette.SurfaceHigh,
    onSurfaceVariant = Palette.TextSecondary,
    surfaceContainer = Palette.Surface,
    surfaceContainerHigh = Palette.SurfaceHigh,
    surfaceContainerHighest = Palette.SurfaceHighest,
    surfaceContainerLow = Palette.Surface,
    outline = Palette.Stroke,
    outlineVariant = Palette.Stroke,
    error = Palette.Red,
)

private val typography = Typography(
    headlineLarge = TextStyle(fontSize = 30.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.5).sp),
    headlineSmall = TextStyle(fontSize = 22.sp, fontWeight = FontWeight.SemiBold),
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
    bodyLarge = TextStyle(fontSize = 16.sp),
    bodyMedium = TextStyle(fontSize = 14.sp),
    bodySmall = TextStyle(fontSize = 12.sp),
    labelLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
    labelMedium = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Medium, letterSpacing = 0.4.sp),
)

private val shapes = Shapes(
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(24.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

@Composable
fun SubLabTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = colors, typography = typography, shapes = shapes, content = content)
}

package app.teamstation.app.sponsormedia

import app.teamstation.app.sponsormedia.SponsorMediaCore.Crop
import app.teamstation.app.sponsormedia.SponsorMediaCore.Size
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SponsorMediaCoreTest {
  @Test
  fun fitShrinksKeepingProportionsAndNeverEnlarges() {
    assertEquals(Size(480, 270), SponsorMediaCore.fit(960, 540, 480.0, 270.0, even = false))
    assertEquals(Size(300, 100), SponsorMediaCore.fit(300, 100, 480.0, 270.0, even = false))
    assertEquals(Size(1, 1), SponsorMediaCore.fit(10, 1, 1.0, 1.0, even = false))
  }

  @Test
  fun evenFitsRoundEachSideDownToEven() {
    assertEquals(Size(640, 360), SponsorMediaCore.fit(3840, 2160, 640.0, 360.0, even = true))
    // 1080 × 1920 portrait: 202.5 wide at 360 high, so 202.
    assertEquals(Size(202, 360), SponsorMediaCore.fit(1080, 1920, 640.0, 360.0, even = true))
    assertEquals(Size(2, 2), SponsorMediaCore.fit(3, 1, 1.0, 1.0, even = true))
  }

  @Test
  fun squareCropsAreCentred() {
    assertEquals(Crop(100, 0, 200, 200), SponsorMediaCore.squareCrop(400, 200))
    assertEquals(Crop(0, 50, 100, 100), SponsorMediaCore.squareCrop(100, 200))
  }

  @Test
  fun coverCropsAnchorToTheUpperRight() {
    // Wider than 1920:224: the right-hand part, full height.
    val (wide, wideSize) = SponsorMediaCore.coverCrop(4000, 224, 1920.0, 224.0)
    assertEquals(Crop(2080, 0, 1920, 224), wide)
    assertEquals(Size(1920, 224), wideSize)
    // Narrower: the top part, full width, never enlarged.
    val (narrow, narrowSize) = SponsorMediaCore.coverCrop(960, 540, 1920.0, 224.0)
    assertEquals(Crop(0, 0, 960, 112), narrow)
    assertEquals(Size(960, 112), narrowSize)
  }

  @Test
  fun formatsAreNamed() {
    assertEquals(SponsorMediaCore.Format.PNG, SponsorMediaCore.format("png"))
    assertEquals("jpg", SponsorMediaCore.format("jpeg").extension)
    val problem = assertThrows(SponsorMediaCore.Problem::class.java) { SponsorMediaCore.format("gif") }
    assertEquals(SponsorMediaCore.PICTURE_PROBLEM, problem.sentence)
  }

  @Test
  fun reelPlansAreUprightWithinTheBoxAtTheOptions() {
    assertEquals(
        SponsorMediaCore.ReelPlan(640, 360, 30f, 1_000_000, 128_000),
        SponsorMediaCore.reelPlan(1920, 1080, 0, 640.0, 360.0, 30.0, 1_000_000.0, 128_000.0))
    // A portrait phone video, stored sideways and turned 90°.
    assertEquals(
        SponsorMediaCore.ReelPlan(202, 360, 30f, 1_000_000, 128_000),
        SponsorMediaCore.reelPlan(1920, 1080, 90, 640.0, 360.0, 30.0, 1_000_000.0, 128_000.0))
    assertEquals(Size(1080, 1920), SponsorMediaCore.upright(1920, 1080, 270))
    assertEquals(Size(1920, 1080), SponsorMediaCore.upright(1920, 1080, 180))
  }

  @Test
  fun aReelWithoutASizeIsRefused() {
    for ((width, height, fps) in listOf(Triple(0, 360, 30.0), Triple(640, 0, 30.0), Triple(640, 360, 0.0))) {
      val problem =
          assertThrows(SponsorMediaCore.Problem::class.java) {
            SponsorMediaCore.reelPlan(width, height, 0, 640.0, 360.0, fps, 1.0, 1.0)
          }
      assertEquals(SponsorMediaCore.VIDEO_PROBLEM, problem.sentence)
    }
  }
}

import CameramanControlUI
import Testing

@Suite("Range slider arithmetic")
struct RangeSliderGeometryTests {
  /// The stream's bitrate slider: 1 to 10 Mbps in half-megabit steps, over 180 points of travel.
  private let stream = RangeSliderGeometry(bounds: 1 ... 10, step: 0.5, width: 180)

  @Test("A point on the track reads as the nearest step")
  func snapsToSteps() {
    #expect(stream.value(at: 0) == 1)
    #expect(stream.value(at: 180) == 10)
    // 20 points per megabit: 50 points is 3.5 Mbps exactly, 52 still rounds to it.
    #expect(stream.value(at: 50) == 3.5)
    #expect(stream.value(at: 52) == 3.5)
    #expect(stream.value(at: 56) == 4)
  }

  @Test("Positions off the ends of the track stay inside the bounds")
  func clampsToBounds() {
    #expect(stream.value(at: -40) == 1)
    #expect(stream.value(at: 400) == 10)
    #expect(stream.position(of: 0) == 0)
    #expect(stream.position(of: 25) == 180)
  }

  @Test("A value and its position agree both ways")
  func positionRoundTrips() {
    for value in stride(from: 1.0, through: 10.0, by: 0.5) {
      #expect(stream.value(at: stream.position(of: value)) == value)
    }
  }

  @Test("A drag moves the nearer point")
  func nearerThumbMoves() {
    // Low at 2 Mbps (20 pt), high at 6 Mbps (100 pt).
    #expect(stream.thumb(nearest: 30, lower: 2, upper: 6, movement: 0) == .lower)
    #expect(stream.thumb(nearest: 90, lower: 2, upper: 6, movement: 0) == .upper)
  }

  /// Two points that have met must still come apart: whichever way the drag heads decides.
  @Test("Points on top of each other are told apart by the drag's direction")
  func overlappingThumbsFollowDirection() {
    #expect(stream.thumb(nearest: 100, lower: 6, upper: 6, movement: -3) == .lower)
    #expect(stream.thumb(nearest: 100, lower: 6, upper: 6, movement: 3) == .upper)
    #expect(stream.thumb(nearest: 100, lower: 6, upper: 6, movement: 0) == nil)
  }
}

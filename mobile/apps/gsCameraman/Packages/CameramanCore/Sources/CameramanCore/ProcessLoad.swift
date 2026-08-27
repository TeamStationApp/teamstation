import Darwin
import Foundation

/// Live CPU and memory for this process, as a share of the whole machine.
///
/// Exists to answer one question that encode and RTSP counters cannot: when the camera dies or
/// Director loses the client, was Cameraman out of RAM, out of CPU, or was the listener/session
/// itself torn down? Those have different fixes and look identical from a frame counter.
public enum ProcessLoad {
  /// Percentage of total machine CPU capacity this process is using, where 100 means every core is
  /// saturated. Summed across live threads.
  public static func cpuPercent() -> Double {
    var threads: thread_act_array_t?
    var count = mach_msg_type_number_t(0)
    guard task_threads(mach_task_self_, &threads, &count) == KERN_SUCCESS, let threads else {
      return 0
    }
    defer {
      vm_deallocate(
        mach_task_self_,
        vm_address_t(UInt(bitPattern: threads)),
        vm_size_t(Int(count) * MemoryLayout<thread_t>.stride)
      )
    }

    var total: Double = 0
    for index in 0 ..< Int(count) {
      // `task_threads` returns a send right per thread. Releasing only the array leaks those
      // rights; polling that from dump-state for hours is how a soak would grow until jetsam.
      defer { mach_port_deallocate(mach_task_self_, threads[index]) }
      var info = thread_basic_info()
      var size = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<natural_t>.size)
      let result = withUnsafeMutablePointer(to: &info) { pointer in
        pointer.withMemoryRebound(to: integer_t.self, capacity: Int(size)) {
          thread_info(threads[index], thread_flavor_t(THREAD_BASIC_INFO), $0, &size)
        }
      }
      guard result == KERN_SUCCESS, info.flags & TH_FLAGS_IDLE == 0 else { continue }
      total += Double(info.cpu_usage) / Double(TH_USAGE_SCALE)
    }

    let cores = Double(ProcessInfo.processInfo.activeProcessorCount)
    return cores > 0 ? (total / cores) * 100 : 0
  }

  public static var coreCount: Int {
    ProcessInfo.processInfo.activeProcessorCount
  }

  /// What the app is allowed to allocate before iOS kills it.
  public static func availableMemoryMB() -> Int {
    Int(os_proc_available_memory() / (1024 * 1024))
  }

  /// Physical memory this process is actually holding. `availableMemoryMB` shrinks for other
  /// reasons too, so this is the number that tells a leak from the system being busy.
  public static func physFootprintMB() -> Int {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
      MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size
    )
    let result = withUnsafeMutablePointer(to: &info) { pointer in
      pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }
    guard result == KERN_SUCCESS else { return 0 }
    return Int(info.phys_footprint / (1024 * 1024))
  }

  public static func thermalStateName(
    _ thermalState: ProcessInfo.ThermalState = ProcessInfo.processInfo.thermalState
  ) -> String {
    switch thermalState {
    case .nominal: "nominal"
    case .fair: "fair"
    case .serious: "serious"
    case .critical: "critical"
    @unknown default: "unknown"
    }
  }
}

import Darwin

enum MacEventClock {
    // CGEvent.timestamp uses mach absolute ticks. DispatchTime.uptimeNanoseconds
    // converts those ticks and must never be compared with the raw event value.
    static func now() -> UInt64 { mach_absolute_time() }
    static func isCurrent(_ eventTimestamp: UInt64, since registration: UInt64) -> Bool {
        eventTimestamp >= registration
    }
}

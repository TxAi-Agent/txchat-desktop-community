import Foundation

enum ModifierReleasePolicy {
    enum Decision: Equatable { case wait, proceed, reject }
    static func decide(modifiersHeld: Bool, elapsed: TimeInterval) -> Decision {
        if !modifiersHeld { return .proceed }
        return elapsed < 1 ? .wait : .reject
    }
}

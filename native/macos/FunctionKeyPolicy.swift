import AppKit

// The caller must reset it whenever input continuity or permission is lost.
enum FunctionKeyInput {
    case flagsChanged(keyCode: UInt16, flags: NSEvent.ModifierFlags)
    case keyDown(keyCode: UInt16)
    case keyUp(keyCode: UInt16)
}
enum FunctionKeyDecision: Equatable {
    case passThrough
    case suppress
    case triggerAndSuppress
    var suppressesSystemEvent: Bool { self != .passThrough }
}
struct FunctionKeyPolicy {
    private enum Companion { case idle, awaitingKeyDown, awaitingKeyUp }
    private var companion = Companion.idle
    private(set) var functionPressed = false
    private var standaloneCandidate = false
    var needsContinuity: Bool { functionPressed || companion != .idle }

    mutating func update(_ event: FunctionKeyInput) -> FunctionKeyDecision {
        // Only the immediately following 179 down/up pair belongs to Globe.
        // An intervening event clears the expectation and is processed normally.
        switch companion {
        case .awaitingKeyDown:
            if case .keyDown(let code) = event, code == 179 {
                companion = .awaitingKeyUp; return .suppress
            }
            companion = .idle
        case .awaitingKeyUp:
            if case .keyUp(let code) = event, code == 179 {
                companion = .idle; return .suppress
            }
            companion = .idle
        case .idle: break
        }
        switch event {
        case .keyUp: return .passThrough
        case .keyDown:
            if functionPressed { standaloneCandidate = false }
            return .passThrough
        case .flagsChanged(let code, let flags):
            let independent = flags.intersection(.deviceIndependentFlagsMask)
            let down = independent.contains(.function)
            guard code == 63 else {
                if functionPressed && !independent.subtracting(.function).isEmpty { standaloneCandidate = false }
                return .passThrough
            }
            if down && !functionPressed {
                functionPressed = true; standaloneCandidate = independent == .function
                return standaloneCandidate ? .suppress : .passThrough
            }
            if !down && functionPressed {
                functionPressed = false
                let trigger = standaloneCandidate && independent.isEmpty
                standaloneCandidate = false
                if trigger { companion = .awaitingKeyDown }
                return trigger ? .triggerAndSuppress : .passThrough
            }
            return .passThrough
        }
    }
}

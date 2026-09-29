enum MacFocusNotificationPolicy {
    enum ActivationDecision: Equatable {
        case useObserved
        case refreshObservation
        case reject
    }

    static func activationDecision(wasObserved: Bool, probeSucceeded: Bool, sameAnchor: Bool) -> ActivationDecision {
        guard sameAnchor else { return .reject }
        if wasObserved { return .useObserved }
        return probeSucceeded ? .refreshObservation : .reject
    }

    static func invalidatesTarget(sameFocusedElement: Bool?, sameFocusedWindow: Bool?, deliveryStarted: Bool = false) -> Bool {
        if sameFocusedElement == false || sameFocusedWindow == false { return true }
        // Before paste, unreadable focus must fail closed. Once posted, a transient
        // AX timeout is not evidence of a focus change; the final snapshot is still required.
        return !deliveryStarted && (sameFocusedElement == nil || sameFocusedWindow == nil)
    }
}

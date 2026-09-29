import ApplicationServices

enum MacEditableTargetPolicy {
    static func allows(role: String, enabled: Bool?, selectedTextSettable: Bool,
                       valueSettable: Bool = false, markerRangeSettable: Bool = false,
                       editable: Bool = false, systemPasteEnabled: Bool = false,
                       isSystemFocusedElement: Bool = false, readOnly: Bool? = nil) -> Bool {
        guard !role.lowercased().contains("secure"), !role.lowercased().contains("password"), readOnly != true else { return false }
        // Current responder paste capability is independent of AX write access.
        // Some editable rich-text controls report AXEnabled=false. Treat that
        // property as an AX-path hint, not a veto of confirmed foreground paste.
        if systemPasteEnabled && isSystemFocusedElement { return true }
        guard enabled != false else { return false }
        return [kAXTextAreaRole, kAXTextFieldRole, kAXComboBoxRole, "AXWebArea"].contains(role) &&
            (selectedTextSettable || valueSettable || markerRangeSettable || editable)
    }
}

enum MacPasteDeliveryPolicy {
    static let clipboardHold: TimeInterval = 0.8
    static func outcome(textConfirmed: Bool, eventPosted: Bool, targetContinuous: Bool, clipboardOwned: Bool) -> String {
        guard eventPosted, targetContinuous, clipboardOwned else { return "partialOrUnknown" }
        return textConfirmed ? "inserted" : "submitted"
    }
    static func plainPaste(command: String?, modifiers: UInt32?, enabled: Bool) -> Bool {
        enabled && command?.lowercased() == "v" && (modifiers == nil || modifiers == 0)
    }
}

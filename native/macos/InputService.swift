import AppKit
import ApplicationServices
import Carbon.HIToolbox
import CryptoKit
import Darwin
import Foundation

struct InputFailure: Error { let code: String; init(_ code: String) { self.code = code } }

private struct CapturedTarget {
    let pid: pid_t
    let launched: Date
    let element: AXUIElement
    let window: AXUIElement
    let selection: CFTypeRef?
    let selectionAttribute: String?
    let windowAnchor: Bool
    let created: TimeInterval
}
private struct ClipboardLease { let owner: Int; let items: [NSPasteboardItem] }
private struct OperationResult { let fingerprint: String; let result: [String: Any] }
private struct InsertionProof {
    // Exact UTF-16 units, not canonically equivalent Swift String equality.
    let expectedValue: [UInt16]
    let expectedCaret: Int
}
private struct PendingInsertion {
    let operation: String
    let fingerprint: String
    let target: ObservedTarget
    let proof: InsertionProof?
    let generation: Int64
    let applicationEpoch: UInt64
    let started: TimeInterval
    let completion: ([String: Any]) -> Void
    var continuityLost = false
}
private struct PendingModifierWait {
    let operation: String
    let fingerprint: String
    let token: String
    let target: ObservedTarget
    let generation: Int64
    let params: [String: Any]
    let started: TimeInterval
    var completions: [([String: Any]) -> Void]
}

// Retain notifications for the lifetime of a token. Equal snapshots alone cannot detect away-and-back changes.
private final class ObservedTarget {
    let snapshot: CapturedTarget
    let focusEpoch: UInt64
    var invalidated = false
    var focusChanged = false
    var deliveryStarted = false
    private var observer: AXObserver?
    private var registrations: [(AXUIElement, String)] = []
    private var pointerMonitor: Any?
    init(_ snapshot: CapturedTarget, epoch: UInt64) throws {
        self.snapshot = snapshot; self.focusEpoch = epoch
        var created: AXObserver?
        guard AXObserverCreate(snapshot.pid, { _, _, notification, context in
            guard let context else { return }
            let owner = Unmanaged<ObservedTarget>.fromOpaque(context).takeUnretainedValue()
            if [kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification].contains(notification as String) {
                let app = AXUIElementCreateApplication(owner.snapshot.pid)
                AXUIElementSetMessagingTimeout(app, 0.2)
                var focused: CFTypeRef?
                var window: CFTypeRef?
                let focusedStatus = AXUIElementCopyAttributeValue(app, kAXFocusedUIElementAttribute as CFString, &focused)
                let windowStatus = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &window)
                let sameElement: Bool? = owner.snapshot.windowAnchor ? true : focusedStatus == .success ? focused.map {
                    CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, owner.snapshot.element)
                } : nil
                let sameWindow: Bool? = windowStatus == .success ? window.map {
                    CFGetTypeID($0) == AXUIElementGetTypeID() && CFEqual($0, owner.snapshot.window)
                } : nil
                if MacFocusNotificationPolicy.invalidatesTarget(sameFocusedElement: sameElement,
                    sameFocusedWindow: sameWindow, deliveryStarted: owner.deliveryStarted) {
                    owner.invalidated = true
                    owner.focusChanged = true
                }
            } else {
                owner.invalidated = true
            }
        }, &created) == .success, let created else { throw InputFailure("TARGET_UNAVAILABLE") }
        observer = created
        let application = AXUIElementCreateApplication(snapshot.pid)
        do {
            for (element, notification) in [(application, kAXFocusedUIElementChangedNotification),
                (application, kAXFocusedWindowChangedNotification), (snapshot.element, kAXSelectedTextChangedNotification),
                (snapshot.element, kAXValueChangedNotification)] {
                let status = AXObserverAddNotification(created, element, notification as CFString,
                    Unmanaged.passUnretained(self).toOpaque())
                if status == .success { registrations.append((element, notification)) }
                else if status != .notificationUnsupported && status != .notImplemented { throw InputFailure("TARGET_UNAVAILABLE") }
            }
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(created), .commonModes)
            if snapshot.windowAnchor || snapshot.selection == nil {
                // A click may move between opaque fields in the same window.
                // Record only invalidation, never pointer coordinates or key contents.
                pointerMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
                    self?.invalidated = true; self?.focusChanged = true
                }
            }
        } catch { close(); throw error }
    }
    private func close() {
        if let pointerMonitor { NSEvent.removeMonitor(pointerMonitor); self.pointerMonitor = nil }
        guard let observer else { return }
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        for (element, notification) in registrations { AXObserverRemoveNotification(observer, element, notification as CFString) }
        registrations.removeAll(); self.observer = nil
    }
    deinit { close() }
}

// Independent wire validation: no trust in renderer/TypeScript validation.
private struct PhysicalShortcut: Equatable {
    let code: UInt32?
    let modifiers: UInt32
    static let codes: [String: UInt32] = [
        "KeyA": 0, "KeyS": 1, "KeyD": 2, "KeyF": 3, "KeyH": 4, "KeyG": 5,
        "KeyZ": 6, "KeyX": 7, "KeyC": 8, "KeyV": 9, "IntlBackslash": 10, "KeyB": 11,
        "KeyQ": 12, "KeyW": 13, "KeyE": 14, "KeyR": 15, "KeyY": 16, "KeyT": 17,
        "Digit1": 18, "Digit2": 19, "Digit3": 20, "Digit4": 21, "Digit6": 22, "Digit5": 23,
        "Equal": 24, "Digit9": 25, "Digit7": 26, "Minus": 27, "Digit8": 28, "Digit0": 29,
        "BracketRight": 30, "KeyO": 31, "KeyU": 32, "BracketLeft": 33, "KeyI": 34, "KeyP": 35,
        "Enter": 36, "KeyL": 37, "KeyJ": 38, "Quote": 39, "KeyK": 40, "Semicolon": 41,
        "Backslash": 42, "Comma": 43, "Slash": 44, "KeyN": 45, "KeyM": 46, "Period": 47,
        "Tab": 48, "Space": 49, "Backquote": 50, "Backspace": 51, "Escape": 53,
        "Clear": 71, "Help": 114, "NumpadDecimal": 65, "NumpadMultiply": 67, "NumpadAdd": 69, "NumpadDivide": 75,
        "NumpadEnter": 76, "NumpadSubtract": 78, "NumpadEqual": 81,
        "Numpad0": 82, "Numpad1": 83, "Numpad2": 84, "Numpad3": 85, "Numpad4": 86,
        "Numpad5": 87, "Numpad6": 88, "Numpad7": 89, "Numpad8": 91, "Numpad9": 92,
        "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
        "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
        "F13": 105, "F14": 107, "F15": 113, "F16": 106, "F17": 64, "F18": 79,
        "F19": 80, "F20": 90, "Home": 115, "PageUp": 116, "Delete": 117,
        "End": 119, "PageDown": 121, "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
    ]
    static func parse(_ raw: String) throws -> PhysicalShortcut {
        if raw == "fn" { return PhysicalShortcut(code: nil, modifiers: 0) }
        let value = raw == "ctrl-alt-space" ? "key:ctrl+alt:Space" : raw == "ctrl-shift-space" ? "key:ctrl+shift:Space" : raw
        let parts = value.split(separator: ":", omittingEmptySubsequences: false).map(String.init)
        guard value.utf8.count <= 80, parts.count == 3, parts[0] == "key" else { throw InputFailure("INVALID_ARGUMENTS") }
        let names = parts[1].split(separator: "+", omittingEmptySubsequences: false).map(String.init)
        let order = ["ctrl", "alt", "shift", "meta"]
        guard (1...2).contains(names.count), Set(names).count == names.count, names != ["shift"],
              order.filter({ names.contains($0) }) == names else { throw InputFailure("INVALID_ARGUMENTS") }
        guard let code = codes[parts[2]] else {
            if ["Insert", "PrintScreen", "ScrollLock", "Pause"].contains(parts[2]) { throw InputFailure("UNSUPPORTED_BINDING") }
            throw InputFailure("INVALID_ARGUMENTS")
        }
        let flags = ["ctrl": UInt32(controlKey), "alt": UInt32(optionKey), "shift": UInt32(shiftKey), "meta": UInt32(cmdKey)]
        return PhysicalShortcut(code: code, modifiers: names.reduce(0) { $0 | flags[$1]! })
    }
}

// All mutable state belongs to the main AppKit run loop. Only the protocol writer is shared.
final class InputService {
    private let instanceID: String
    private let emit: ([String: Any]) -> Void
    private let parentPID = getppid()
    private var excluded = Set<pid_t>()
    private var targets: [String: ObservedTarget] = [:]
    private var operations: [String: OperationResult] = [:]
    private var focusEpoch: UInt64 = 0
    private var applicationEpoch: UInt64 = 0
    private var workspaceObserver: NSObjectProtocol?
    private var activeFocusObserver: AXObserver?
    private var activeFocusApplication: AXUIElement?
    private var activeFocusPID: pid_t?
    private var activeSelectionElement: AXUIElement?
    private var enabled = false
    private var binding = "ctrl-alt-space"
    private var generation: Int64 = 0
    private var sequence: Int64 = 0
    private var reason: String?
    // Explicit editor-only, one-shot flags capture. Never records characters or external-app keys.
    private var captureTap: CFMachPort?
    private var captureSource: CFRunLoopSource?
    private var captureID: String?
    private var captureStarted: UInt64 = 0
    private var captureEventStarted: UInt64 = 0
    private var captureTimer: Timer?
    private var captureObserver: NSObjectProtocol?
    private var tap: CFMachPort?
    private var tapSource: CFRunLoopSource?
    private var hotkey: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private var hotkeyID: UInt32 = 0
    private var nextHotkeyID: UInt32 = 1
    private var registrationTime: EventTime = 0
    private var registrationEventTime: UInt64 = 0
    private var pressed = false
    private var functionPolicy = FunctionKeyPolicy()
    private var functionContext: (pid: pid_t, launched: Date, focusEpoch: UInt64)?
    private var clipboard: ClipboardLease?
    private var modifierWait: PendingModifierWait?
    private var pendingInsertion: PendingInsertion?
    private static let maximumConfirmationUTF16 = 65_536

    init(instanceID: String, emit: @escaping ([String: Any]) -> Void) {
        self.instanceID = instanceID; self.emit = emit
    }
    func handle(_ method: String, params: [String: Any]?) throws -> [String: Any] {
        switch method {
        case "shortcutKeyLabel":
            let p = try arguments(params, keys: ["code", "shift"])
            guard let code = p["code"] as? String, let keyCode = PhysicalShortcut.codes[code],
                  let shift = p["shift"] as? Bool, type(of: p["shift"]!) == Bool.self else { throw InputFailure("INVALID_ARGUMENTS") }
            return try shortcutKeyLabel(keyCode, shift: shift)
        case "beginShortcutCapture":
            let p = try arguments(params, keys: ["captureId"])
            return try beginShortcutCapture(try uuid(p["captureId"]))
        case "endShortcutCapture":
            let p = try arguments(params, keys: ["captureId"])
            let id = try uuid(p["captureId"])
            if captureID == id { stopShortcutCapture() }
            return ["active": false]
        case "status": return status()
        case "requestPermissions", "requestAccessibility":
            guard params == nil else { throw InputFailure("INVALID_ARGUMENTS") }
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
            return status()
        case "configure": return try configure(params ?? [:])
        case "captureTarget": return try capture()
        case "releaseTarget":
            let p = try arguments(params, keys: ["targetId"])
            let token = try uuid(p["targetId"])
            if modifierWait?.token == token { finishModifierWait(reason: "TARGET_UNAVAILABLE") }
            targets.removeValue(forKey: token)
            return ["released": true]
        default: throw InputFailure("UNSUPPORTED_METHOD")
        }
    }
    private func beginShortcutCapture(_ id: String) throws -> [String: Any] {
        stopShortcutCapture()
        guard !enabled, pendingInsertion == nil, !IsSecureEventInputEnabled(),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == parentPID else { throw InputFailure("INPUT_BUSY") }
        guard AXIsProcessTrusted() else { throw InputFailure("PERMISSION_REQUIRED") }
        let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
        guard let newTap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
            eventsOfInterest: mask, callback: { _, type, event, context in
                if let context { Unmanaged<InputService>.fromOpaque(context).takeUnretainedValue().captureFlags(type, event) }
                return Unmanaged.passUnretained(event)
            }, userInfo: Unmanaged.passUnretained(self).toOpaque()),
            let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, newTap, 0) else { throw InputFailure("HOTKEY_UNAVAILABLE") }
        captureID = id; captureTap = newTap; captureSource = source
        captureStarted = DispatchTime.now().uptimeNanoseconds
        captureEventStarted = MacEventClock.now()
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: newTap, enable: true)
        let timer = Timer(timeInterval: 30, repeats: false) { [weak self] _ in self?.finishShortcutCapture("unavailable") }
        captureTimer = timer; RunLoop.main.add(timer, forMode: .common)
        captureObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            guard let self, NSWorkspace.shared.frontmostApplication?.processIdentifier != self.parentPID else { return }
            self.finishShortcutCapture("unavailable")
        }
        return ["active": true]
    }
    // Layout lookup only: no key monitor or TCC Input Monitoring permission is needed.
    // Match charactersIgnoringModifiers: preserve Shift, remove Option/Control/Command.
    private func shortcutKeyLabel(_ code: UInt32, shift: Bool) throws -> [String: Any] {
        guard !enabled, pendingInsertion == nil, !IsSecureEventInputEnabled(),
              NSWorkspace.shared.frontmostApplication?.processIdentifier == parentPID else { throw InputFailure("INPUT_BUSY") }
        guard let source = TISCopyCurrentKeyboardLayoutInputSource()?.takeRetainedValue(),
              let property = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData) else { throw InputFailure("HOTKEY_UNAVAILABLE") }
        let data = Unmanaged<CFData>.fromOpaque(property).takeUnretainedValue()
        guard let bytes = CFDataGetBytePtr(data) else { throw InputFailure("HOTKEY_UNAVAILABLE") }
        let layout = UnsafeRawPointer(bytes).assumingMemoryBound(to: UCKeyboardLayout.self)
        var deadState: UInt32 = 0
        var length = 0
        var characters = [UniChar](repeating: 0, count: 8)
        let result = UCKeyTranslate(layout, UInt16(code), UInt16(kUCKeyActionDisplay),
            shift ? UInt32(shiftKey >> 8) : 0, UInt32(LMGetKbdType()),
            OptionBits(1 << kUCKeyTranslateNoDeadKeysBit), &deadState, characters.count, &length, &characters)
        guard result == noErr, length > 0, length <= characters.count else { throw InputFailure("HOTKEY_UNAVAILABLE") }
        return ["key": String(utf16CodeUnits: characters, count: length)]
    }
    private func captureFlags(_ type: CGEventType, _ event: CGEvent) {
        guard captureID != nil else { return }
        guard type == .flagsChanged, !IsSecureEventInputEnabled(), NSWorkspace.shared.frontmostApplication?.processIdentifier == parentPID,
              AXIsProcessTrusted() else { finishShortcutCapture("unavailable"); return }
        guard DispatchTime.now().uptimeNanoseconds - captureStarted < 30_000_000_000 else { finishShortcutCapture("unavailable"); return }
        guard MacEventClock.isCurrent(event.timestamp, since: captureEventStarted) else { return }
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        if code == Int64(kVK_Function), event.flags.contains(.maskSecondaryFn) {
            let other = !event.flags.intersection([.maskControl, .maskAlternate, .maskShift, .maskCommand]).isEmpty
            finishShortcutCapture(other ? "fn-combination" : "fn")
        } else if code == Int64(kVK_RightOption), event.flags.contains(.maskAlternate) {
            finishShortcutCapture("right-option")
        }
    }
    private func finishShortcutCapture(_ key: String) {
        guard let id = captureID else { return }
        stopShortcutCapture(); sequence += 1
        emit(["v": 1, "event": "shortcutCapture", "instanceId": instanceID, "sequence": sequence, "captureId": id, "key": key])
    }
    private func stopShortcutCapture() {
        captureID = nil; captureTimer?.invalidate(); captureTimer = nil
        if let captureTap { CGEvent.tapEnable(tap: captureTap, enable: false); CFMachPortInvalidate(captureTap) }
        if let captureSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), captureSource, .commonModes) }
        captureTap = nil; captureSource = nil
        if let captureObserver { NSWorkspace.shared.notificationCenter.removeObserver(captureObserver) }
        captureObserver = nil
    }
    private func status() -> [String: Any] {
        let trusted = AXIsProcessTrusted()
        if enabled && !trusted {
            finishModifierWait(reason: "PERMISSION_REQUIRED")
            finishInsertion(confirmed: false)
            stopHotkey(); targets.removeAll(); enabled = false; reason = "PERMISSION_REQUIRED"
            stopFocusTracking()
        }
        return ["accessibility": trusted ? "granted" : "denied",
                "inputMonitoring": "notRequired",
                "enabled": enabled, "binding": binding, "generation": generation,
                "reason": reason as Any? ?? NSNull()]
    }
    private func arguments(_ params: [String: Any]?, keys: Set<String>) throws -> [String: Any] {
        guard let params, Set(params.keys) == keys else { throw InputFailure("INVALID_ARGUMENTS") }
        return params
    }
    private func uuid(_ value: Any?) throws -> String {
        guard let value = value as? String, UUID(uuidString: value) != nil else { throw InputFailure("INVALID_ARGUMENTS") }
        return value.lowercased()
    }
    private func identifier(_ value: Any?) throws -> String {
        guard let value = value as? String, (1...64).contains(value.utf8.count),
              value.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 || $0 == 95 }) else {
            throw InputFailure("INVALID_ARGUMENTS")
        }
        return value
    }
    private func configure(_ params: [String: Any]) throws -> [String: Any] {
        let p = try arguments(params, keys: ["enabled", "binding", "generation", "excludedPids"])
        guard let rawEnabled = p["enabled"], type(of: rawEnabled) == Bool.self, let newEnabled = rawEnabled as? Bool,
              let nextBinding = p["binding"] as? String,
              let rawGeneration = p["generation"], type(of: rawGeneration) == Int64.self,
              let nextGeneration = rawGeneration as? Int64, (1...2_147_483_647).contains(nextGeneration),
              nextGeneration > generation, let pids = p["excludedPids"] as? [Any], (1...64).contains(pids.count) else {
            throw InputFailure("INVALID_ARGUMENTS")
        }
        stopShortcutCapture()
        let parsedBinding = try PhysicalShortcut.parse(nextBinding)
        let own = try pids.map { value -> pid_t in
            guard type(of: value) == Int64.self, let pid = value as? Int64, (1...Int64(Int32.max)).contains(pid) else { throw InputFailure("INVALID_ARGUMENTS") }
            return pid_t(pid)
        }
        if newEnabled {
            guard AXIsProcessTrusted() else { throw InputFailure("PERMISSION_REQUIRED") }
            if !enabled || (try? PhysicalShortcut.parse(binding)) != parsedBinding { try installHotkey(nextBinding) }
            if workspaceObserver == nil {
                workspaceObserver = NSWorkspace.shared.notificationCenter.addObserver(
                    forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
                        self?.resetFunctionPolicy()
                        self?.focusEpoch &+= 1; self?.applicationEpoch &+= 1; self?.trackFrontmost()
                    }
            }
        } else { stopHotkey() }
        finishModifierWait(reason: "TARGET_CHANGED")
        finishInsertion(confirmed: false)
        restoreClipboard()
        targets.removeAll(); pressed = false; resetFunctionPolicy()
        registrationTime = GetCurrentEventTime()
        registrationEventTime = MacEventClock.now()
        enabled = newEnabled; binding = nextBinding; generation = nextGeneration; excluded = Set(own); reason = nil
        trackFrontmost()
        return status()
    }
    private func stopFocusTracking() {
        if let observer = activeFocusObserver, let application = activeFocusApplication {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
            AXObserverRemoveNotification(observer, application, kAXFocusedUIElementChangedNotification as CFString)
            AXObserverRemoveNotification(observer, application, kAXFocusedWindowChangedNotification as CFString)
            if let element = activeSelectionElement {
                AXObserverRemoveNotification(observer, element, kAXSelectedTextChangedNotification as CFString)
            }
        }
        activeFocusObserver = nil; activeFocusApplication = nil; activeFocusPID = nil; activeSelectionElement = nil
    }
    private func trackFrontmost() {
        stopFocusTracking()
        guard enabled, AXIsProcessTrusted(), let application = NSWorkspace.shared.frontmostApplication else { return }
        let element = AXUIElementCreateApplication(application.processIdentifier)
        AXUIElementSetMessagingTimeout(element, 0.4)
        var observer: AXObserver?
        guard AXObserverCreate(application.processIdentifier, { _, _, notification, context in
            guard let context else { return }
            let owner = Unmanaged<InputService>.fromOpaque(context).takeUnretainedValue()
            owner.focusEpoch &+= 1
            if notification as String != kAXSelectedTextChangedNotification {
                owner.resetFunctionPolicy(); owner.trackSelection()
            }
        }, &observer) == .success, let observer else { return }
        activeFocusObserver = observer; activeFocusApplication = element
        for name in [kAXFocusedUIElementChangedNotification, kAXFocusedWindowChangedNotification] {
            let status = AXObserverAddNotification(observer, element, name as CFString,
                Unmanaged.passUnretained(self).toOpaque())
            guard status == .success || status == .notificationUnsupported || status == .notImplemented else { stopFocusTracking(); return }
        }
        activeFocusPID = application.processIdentifier
        CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        trackSelection()
    }
    private func trackSelection() {
        guard let observer = activeFocusObserver, let application = activeFocusApplication else { return }
        if let previous = activeSelectionElement {
            AXObserverRemoveNotification(observer, previous, kAXSelectedTextChangedNotification as CFString)
        }
        activeSelectionElement = nil
        guard let element = elementAttribute(application, kAXFocusedUIElementAttribute) ?? elementAttribute(application, kAXFocusedWindowAttribute) else { return }
        _ = AXObserverAddNotification(observer, element, kAXSelectedTextChangedNotification as CFString,
            Unmanaged.passUnretained(self).toOpaque())
        activeSelectionElement = element
    }
    private func installHotkey(_ value: String) throws {
        if value == "fn" {
            let mask = [CGEventType.flagsChanged, .keyDown, .keyUp].reduce(CGEventMask(0)) {
                $0 | (CGEventMask(1) << $1.rawValue)
            }
            guard let newTap = CGEvent.tapCreate(tap: .cghidEventTap, place: .headInsertEventTap, options: .defaultTap,
                eventsOfInterest: mask, callback: { _, type, event, context in
                    guard let context else { return Unmanaged.passUnretained(event) }
                    let owner = Unmanaged<InputService>.fromOpaque(context).takeUnretainedValue()
                    return owner.fnEvent(type: type, event: event).suppressesSystemEvent ? nil : Unmanaged.passUnretained(event)
                }, userInfo: Unmanaged.passUnretained(self).toOpaque()),
                let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, newTap, 0) else { throw InputFailure("HOTKEY_UNAVAILABLE") }
            stopHotkey(); tap = newTap; tapSource = source
            CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes); CGEvent.tapEnable(tap: newTap, enable: true)
            return
        }
        if handler == nil {
            var types = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
                         EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased))]
            let result = InstallEventHandler(GetApplicationEventTarget(), { _, event, context in
                guard let event, let context else { return OSStatus(eventNotHandledErr) }
                let owner = Unmanaged<InputService>.fromOpaque(context).takeUnretainedValue()
                var id = EventHotKeyID()
                guard GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                    nil, MemoryLayout<EventHotKeyID>.size, nil, &id) == noErr,
                    id.signature == 0x54584348, id.id == owner.hotkeyID, owner.hotkey != nil,
                    GetEventTime(event) >= owner.registrationTime else { return OSStatus(eventNotHandledErr) }
                owner.key(GetEventKind(event) == UInt32(kEventHotKeyPressed))
                return noErr
            }, types.count, &types, Unmanaged.passUnretained(self).toOpaque(), &handler)
            guard result == noErr else { throw InputFailure("HOTKEY_UNAVAILABLE") }
        }
        let shortcut = try PhysicalShortcut.parse(value)
        guard let code = shortcut.code else { throw InputFailure("INVALID_ARGUMENTS") }
        var replacement: EventHotKeyRef?
        let id = nextHotkeyID; nextHotkeyID &+= 1
        let result = RegisterEventHotKey(code, shortcut.modifiers, EventHotKeyID(signature: 0x54584348, id: id),
                                        GetApplicationEventTarget(), 0, &replacement)
        guard result == noErr, let replacement else { throw InputFailure("HOTKEY_CONFLICT") }
        stopHotkey(); hotkey = replacement; hotkeyID = id
    }
    private func stopHotkey() {
        if let hotkey { UnregisterEventHotKey(hotkey) }; hotkey = nil; hotkeyID = 0
        if let tap { CGEvent.tapEnable(tap: tap, enable: false); CFMachPortInvalidate(tap) }; tap = nil
        if let tapSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), tapSource, .commonModes) }; tapSource = nil
        pressed = false; resetFunctionPolicy()
    }
    private func resetFunctionPolicy() {
        functionPolicy = FunctionKeyPolicy(); functionContext = nil
    }
    private func fnEvent(type: CGEventType, event: CGEvent) -> FunctionKeyDecision {
        guard enabled, binding == "fn", tap != nil else { return .passThrough }
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            // Losing input continuity cannot synthesize a release or resume a task.
            finishInsertion(confirmed: false)
            stopHotkey(); enabled = false; reason = "HOTKEY_UNAVAILABLE"; targets.removeAll(); stopFocusTracking()
            return .passThrough
        }
        guard AXIsProcessTrusted() else {
            finishInsertion(confirmed: false)
            stopHotkey(); enabled = false; reason = "PERMISSION_REQUIRED"; targets.removeAll(); stopFocusTracking()
            return .passThrough
        }
        guard MacEventClock.isCurrent(event.timestamp, since: registrationEventTime) else { return .passThrough }
        guard !IsSecureEventInputEnabled(),
              let application = NSWorkspace.shared.frontmostApplication,
              !application.isTerminated, let launched = application.launchDate else {
            resetFunctionPolicy(); return .passThrough
        }
        // Do not join a down/companion from one focused target to a later target.
        if let context = functionContext,
           context.pid != application.processIdentifier || context.launched != launched || context.focusEpoch != focusEpoch {
            resetFunctionPolicy()
        }
        let code = UInt16(truncatingIfNeeded: event.getIntegerValueField(.keyboardEventKeycode))
        let input: FunctionKeyInput
        switch type {
        case .flagsChanged:
            guard let nativeEvent = NSEvent(cgEvent: event) else { resetFunctionPolicy(); return .passThrough }
            input = .flagsChanged(keyCode: code, flags: nativeEvent.modifierFlags)
        case .keyDown: input = .keyDown(keyCode: code)
        case .keyUp: input = .keyUp(keyCode: code)
        default: return .passThrough
        }
        let wasPressed = functionPolicy.functionPressed
        let decision = functionPolicy.update(input)
        if functionPolicy.needsContinuity {
            functionContext = (application.processIdentifier, launched, focusEpoch)
        } else { functionContext = nil }
        if functionPolicy.functionPressed != wasPressed {
            sendKey(functionPolicy.functionPressed ? "pressed" : "released", token: nil, error: nil)
        }
        // Only the policy's standalone Fn release activates. Companion suppression
        // and Carbon's physical edges never route through this action a second time.
        if decision == .triggerAndSuppress { activate() }
        return decision
    }
    private func key(_ down: Bool) {
        guard enabled, binding != "fn" else { return }
        if down {
            guard !pressed else { return }
            pressed = true; sendKey("pressed", token: nil, error: nil)
            activate()
        } else {
            guard pressed else { return }
            pressed = false; sendKey("released", token: nil, error: nil)
        }
    }
    private func activate() {
        let leaseGeneration = generation
        let leaseEpoch = focusEpoch
        let activationApp = NSWorkspace.shared.frontmostApplication
        let activationPID = activationApp?.processIdentifier
        let activationLaunch = activationApp?.launchDate
        let activationSecureInput = IsSecureEventInputEnabled()
        let activationElement = activeSelectionElement
        let activationWasObserved = activationPID != nil && activeFocusPID == activationPID && activationElement != nil
        // Return from low-level callback before potentially slow AX operations.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.enabled, self.generation == leaseGeneration else { return }
            func finishActivation(token: String?, error: String?) {
                guard self.enabled, self.generation == leaseGeneration else {
                    if let token { self.targets.removeValue(forKey: token) }
                    return
                }
                let frontmost = NSWorkspace.shared.frontmostApplication
                let sameActivationAnchor = activationPID != nil && activationLaunch != nil &&
                    self.focusEpoch == leaseEpoch && frontmost?.processIdentifier == activationPID &&
                    frontmost?.launchDate == activationLaunch && !(frontmost?.isTerminated ?? true)
                let finalError: String?
                if error == "PROTECTED_TARGET" || activationSecureInput || IsSecureEventInputEnabled() {
                    finalError = "PROTECTED_TARGET"
                } else {
                    finalError = sameActivationAnchor ? error : "TARGET_CHANGED"
                }
                if finalError != nil, let token { self.targets.removeValue(forKey: token) }
                self.sendKey("activated", token: finalError == nil ? token : nil, error: finalError)
            }
            do {
                guard !activationSecureInput, !IsSecureEventInputEnabled() else { throw InputFailure("PROTECTED_TARGET") }
                func sameActivationAnchor() -> Bool {
                    self.focusEpoch == leaseEpoch &&
                    NSWorkspace.shared.frontmostApplication?.processIdentifier == activationPID &&
                    NSWorkspace.shared.frontmostApplication?.launchDate == activationLaunch
                }
                guard sameActivationAnchor() else { throw InputFailure("TARGET_CHANGED") }
                var expectedElement = activationElement
                var probeSucceeded = false
                if !activationWasObserved {
                    // Classify protected fields and warm lazy Chromium/WebKit AX trees.
                    _ = try self.current()
                    probeSucceeded = true
                }
                switch MacFocusNotificationPolicy.activationDecision(wasObserved: activationWasObserved,
                    probeSucceeded: probeSucceeded, sameAnchor: sameActivationAnchor()) {
                case .useObserved: break
                case .refreshObservation:
                    self.trackSelection()
                    guard sameActivationAnchor(), self.activeFocusPID == activationPID,
                          let refreshedElement = self.activeSelectionElement else { throw InputFailure("TARGET_CHANGED") }
                    expectedElement = refreshedElement
                case .reject: throw InputFailure("TARGET_CHANGED")
                }
                guard self.activeFocusPID == activationPID, self.focusEpoch == leaseEpoch, let activationPID, let activationLaunch,
                      NSWorkspace.shared.frontmostApplication?.processIdentifier == activationPID,
                      NSWorkspace.shared.frontmostApplication?.launchDate == activationLaunch else { throw InputFailure("TARGET_CHANGED") }
                let captured = try self.capture()
                guard self.focusEpoch == leaseEpoch,
                      NSWorkspace.shared.frontmostApplication?.processIdentifier == activationPID,
                      let token = captured["targetId"] as? String, let capturedTarget = self.targets[token],
                      let expectedElement, CFEqual(capturedTarget.snapshot.element, expectedElement) else {
                    if let token = captured["targetId"] as? String { self.targets.removeValue(forKey: token) }
                    throw InputFailure("TARGET_CHANGED")
                }
                finishActivation(token: captured["targetId"] as? String, error: nil)
            } catch { finishActivation(token: nil, error: (error as? InputFailure)?.code ?? "TARGET_UNAVAILABLE") }
        }
    }
    private func sendKey(_ phase: String, token: String?, error: String?) {
        sequence += 1
        emit(["v": 1, "event": "hotkey", "instanceId": instanceID, "sequence": sequence, "generation": generation,
              "phase": phase, "targetId": token as Any? ?? NSNull(), "reason": error as Any? ?? NSNull()])
    }
    private func parent(of pid: pid_t) -> pid_t? {
        var info = proc_bsdinfo()
        let size = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, size) == size else { return nil }
        return pid_t(info.pbi_ppid)
    }
    private func ownProcess(_ pid: pid_t) -> Bool {
        var current = pid; var visited = Set<pid_t>()
        for _ in 0..<64 {
            if current == getpid() || current == parentPID || excluded.contains(current) { return true }
            if current <= 1 { return false }
            guard visited.insert(current).inserted, let next = parent(of: current) else { return true }
            current = next
        }
        return true // Unresolvable deep ancestry is not an eligible target.
    }
    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    private func elementAttribute(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }
    private func sameSelection(_ lhs: CFTypeRef?, _ rhs: CFTypeRef?) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil): return true
        case let (left?, right?): return CFEqual(left, right)
        default: return false
        }
    }
    private func enabledPasteCommand(_ application: AXUIElement) -> Bool {
        guard let root = elementAttribute(application, kAXMenuBarAttribute) else { return false }
        var pending = [root]; var seen = Set<CFHashCode>()
        let deadline = ProcessInfo.processInfo.systemUptime + 0.3
        while let node = pending.popLast(), seen.count < 1024, ProcessInfo.processInfo.systemUptime < deadline {
            guard seen.insert(CFHash(node)).inserted else { continue }
            AXUIElementSetMessagingTimeout(node, 0.1)
            if attribute(node, kAXRoleAttribute) as? String == kAXMenuItemRole,
               MacPasteDeliveryPolicy.plainPaste(command: attribute(node, kAXMenuItemCmdCharAttribute) as? String,
                   modifiers: (attribute(node, kAXMenuItemCmdModifiersAttribute) as? NSNumber)?.uint32Value,
                   enabled: attribute(node, kAXEnabledAttribute) as? Bool == true) { return true }
            if let children = attribute(node, kAXChildrenAttribute) as? [AXUIElement] { pending.append(contentsOf: children) }
        }
        return false
    }
    private func canPastePlainText(_ application: AXUIElement) -> Bool {
        let board = NSPasteboard.general
        // During delivery the real result is already the transient clipboard value.
        if let lease = clipboard { return lease.owner == board.changeCount && enabledPasteCommand(application) }
        let originalCount = board.changeCount
        guard let saved = try? saveClipboard(board), board.changeCount == originalCount else { return false }
        // Probe text capability rather than accepting a file/image Paste command.
        let transient = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")
        let owner = board.declareTypes([.string, transient], owner: nil)
        guard board.changeCount == owner else { return false }
        let written = board.setString("\u{2060}", forType: .string)
        let enabled = written && board.changeCount == owner && enabledPasteCommand(application)
        guard board.changeCount == owner else { return false }
        let restoredOwner = board.clearContents()
        guard board.changeCount == restoredOwner else { return false }
        let restored = saved.isEmpty || board.writeObjects(saved)
        return enabled && restored && board.changeCount == restoredOwner
    }
    private func current(timeout: Float = 0.4) throws -> CapturedTarget {
        guard !IsSecureEventInputEnabled() else { throw InputFailure("PROTECTED_TARGET") }
        guard AXIsProcessTrusted() else { throw InputFailure("PERMISSION_REQUIRED") }
        guard let app = NSWorkspace.shared.frontmostApplication, !app.isTerminated, let launch = app.launchDate else { throw InputFailure("TARGET_UNAVAILABLE") }
        let pid = app.processIdentifier
        let ax = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(ax, timeout)
        var focused: CFTypeRef?
        var focusedStatus = AXUIElementCopyAttributeValue(ax, kAXFocusedUIElementAttribute as CFString, &focused)
        if focusedStatus != .success {
            for name in ["AXManualAccessibility", "AXEnhancedUserInterface"] {
                _ = AXUIElementSetAttributeValue(ax, name as CFString, kCFBooleanTrue)
            }
            focusedStatus = AXUIElementCopyAttributeValue(ax, kAXFocusedUIElementAttribute as CFString, &focused)
        }
        // A desktop/no-focus response is an ordinary unavailable target. A failed AX
        // query is not evidence that recognition may proceed in an unclassified field.
        if focusedStatus == .noValue || focusedStatus == .attributeUnsupported || focusedStatus == .notImplemented {
            guard !ownProcess(pid), let window = elementAttribute(ax, kAXFocusedWindowAttribute),
                  canPastePlainText(ax), !IsSecureEventInputEnabled() else { throw InputFailure("TARGET_UNAVAILABLE") }
            return CapturedTarget(pid: pid, launched: launch, element: window, window: window,
                selection: nil, selectionAttribute: nil, windowAnchor: true, created: ProcessInfo.processInfo.systemUptime)
        }
        guard focusedStatus == .success, let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else {
            throw InputFailure("PROTECTED_TARGET")
        }
        let element = focused as! AXUIElement
        AXUIElementSetMessagingTimeout(element, timeout)
        var rawRole: CFTypeRef?
        var rawSubrole: CFTypeRef?
        let roleStatus = AXUIElementCopyAttributeValue(element, kAXRoleAttribute as CFString, &rawRole)
        let subroleStatus = AXUIElementCopyAttributeValue(element, kAXSubroleAttribute as CFString, &rawSubrole)
        guard roleStatus == .success, let role = rawRole as? String, !role.isEmpty else { throw InputFailure("PROTECTED_TARGET") }
        let subrole: String
        if subroleStatus == .noValue || subroleStatus == .attributeUnsupported {
            subrole = "" // Many ordinary controls legitimately have no subrole.
        } else {
            guard subroleStatus == .success, let value = rawSubrole as? String else { throw InputFailure("PROTECTED_TARGET") }
            subrole = value
        }
        guard ![role, subrole].joined().lowercased().contains("secure"),
              ![role, subrole].joined().lowercased().contains("password") else { throw InputFailure("PROTECTED_TARGET") }
        let readOnly = attribute(element, "AXReadOnly") as? Bool
        guard readOnly != true else { throw InputFailure("PROTECTED_TARGET") }
        // Security classification precedes own-process, missing-window and eligibility
        // outcomes because those outcomes may allow recognition without a write target.
        guard !IsSecureEventInputEnabled() else { throw InputFailure("PROTECTED_TARGET") }
        guard !ownProcess(pid) else { throw InputFailure("OWN_APPLICATION") }
        guard let window = elementAttribute(ax, kAXFocusedWindowAttribute) else { throw InputFailure("TARGET_UNAVAILABLE") }
        var owner: pid_t = 0
        guard AXUIElementGetPid(element, &owner) == .success, owner == pid else { throw InputFailure("TARGET_UNAVAILABLE") }
        func settable(_ name: String) -> Bool {
            var value = DarwinBoolean(false)
            return AXUIElementIsAttributeSettable(element, name as CFString, &value) == .success && value.boolValue
        }
        let accessibleEditable = MacEditableTargetPolicy.allows(role: role, enabled: attribute(element, kAXEnabledAttribute) as? Bool,
            selectedTextSettable: settable(kAXSelectedTextAttribute), valueSettable: settable(kAXValueAttribute),
            markerRangeSettable: settable("AXSelectedTextMarkerRange"), editable: attribute(element, "AXEditable") as? Bool == true,
            readOnly: readOnly)
        guard accessibleEditable || MacEditableTargetPolicy.allows(role: role, enabled: attribute(element, kAXEnabledAttribute) as? Bool,
            selectedTextSettable: false, systemPasteEnabled: canPastePlainText(ax),
            // element came directly from this foreground application's focused
            // UI element, not a guessed child or an application-specific lookup.
            isSystemFocusedElement: true, readOnly: readOnly) else { throw InputFailure("TARGET_UNAVAILABLE") }
        let selectionName = attribute(element, kAXSelectedTextRangeAttribute) != nil ? kAXSelectedTextRangeAttribute : "AXSelectedTextMarkerRange"
        let selection = attribute(element, selectionName)
        return CapturedTarget(pid: pid, launched: launch, element: element, window: window,
                              selection: selection, selectionAttribute: selection == nil ? nil : selectionName,
                              windowAnchor: false, created: ProcessInfo.processInfo.systemUptime)
    }
    private func capture() throws -> [String: Any] {
        guard enabled else { throw InputFailure("INPUT_BUSY") }
        let now = ProcessInfo.processInfo.systemUptime
        targets = targets.filter { now - $0.value.snapshot.created < 600 }
        guard targets.count < 16 else { throw InputFailure("CAPACITY_EXCEEDED") }
        let epoch = focusEpoch
        let target = try current()
        let observed = try ObservedTarget(target, epoch: epoch)
        try revalidate(observed)
        let id = UUID().uuidString.lowercased(); targets[id] = observed
        return ["targetId": id, "applicationName": String((NSRunningApplication(processIdentifier: target.pid)?.localizedName ?? "").prefix(128))]
    }
    private func revalidate(_ observed: ObservedTarget) throws {
        guard !observed.invalidated, observed.focusEpoch == focusEpoch else { throw InputFailure("TARGET_CHANGED") }
        let target = observed.snapshot
        guard ProcessInfo.processInfo.systemUptime - target.created < 600 else { throw InputFailure("TARGET_UNAVAILABLE") }
        let now = try current()
        guard now.pid == target.pid, now.launched == target.launched,
              CFEqual(now.element, target.element), CFEqual(now.window, target.window),
              now.windowAnchor == target.windowAnchor, now.selectionAttribute == target.selectionAttribute,
              sameSelection(now.selection, target.selection),
              !observed.invalidated, observed.focusEpoch == focusEpoch else {
            throw InputFailure("TARGET_CHANGED")
        }
    }
    private func saveClipboard(_ pasteboard: NSPasteboard) throws -> [NSPasteboardItem] {
        var saved: [NSPasteboardItem] = []; var bytes = 0
        guard (pasteboard.pasteboardItems?.count ?? 0) <= 64 else { throw InputFailure("INPUT_BUSY") }
        for item in pasteboard.pasteboardItems ?? [] {
            let copy = NSPasteboardItem()
            guard item.types.count <= 128 else { throw InputFailure("INPUT_BUSY") }
            for type in item.types {
                guard let data = item.data(forType: type) else { throw InputFailure("PASTEBOARD_SNAPSHOT_FAILED") }
                bytes += data.count
                guard bytes <= 4_194_304 else { throw InputFailure("INPUT_BUSY") }
                guard copy.setData(data, forType: type) else { throw InputFailure("PASTEBOARD_SNAPSHOT_FAILED") }
            }
            saved.append(copy)
        }
        return saved
    }
    private func restoreClipboard() {
        guard let lease = clipboard else { return }; clipboard = nil
        let board = NSPasteboard.general
        guard board.changeCount == lease.owner else { return } // Preserve newer user/third-party content.
        let restoreOwner = board.clearContents()
        guard board.changeCount == restoreOwner else { return }
        if !lease.items.isEmpty { board.writeObjects(lease.items) }
    }
    private func shortcutModifiersHeld() -> Bool {
        !CGEventSource.flagsState(.combinedSessionState)
            .intersection([.maskCommand, .maskControl, .maskAlternate, .maskShift, .maskSecondaryFn]).isEmpty
    }
    private func finishModifierWait(reason: String) {
        guard let pending = modifierWait else { return }
        modifierWait = nil
        targets.removeValue(forKey: pending.token)
        let value: [String: Any] = ["outcome": "notInserted", "reason": reason]
        operations[pending.operation] = OperationResult(fingerprint: pending.fingerprint, result: value)
        pending.completions.forEach { $0(value) }
    }
    private func scheduleModifierWait(_ operation: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(20)) { [weak self] in
            guard let self, let pending = self.modifierWait, pending.operation == operation else { return }
            guard self.enabled, self.generation == pending.generation,
                  self.targets[pending.token] === pending.target else {
                self.finishModifierWait(reason: "TARGET_CHANGED"); return
            }
            do { try self.revalidate(pending.target) }
            catch {
                self.finishModifierWait(reason: (error as? InputFailure)?.code ?? "TARGET_CHANGED")
                return
            }
            switch ModifierReleasePolicy.decide(modifiersHeld: self.shortcutModifiersHeld(),
                                                elapsed: ProcessInfo.processInfo.systemUptime - pending.started) {
            case .wait: self.scheduleModifierWait(operation)
            case .reject: self.finishModifierWait(reason: "MODIFIERS_HELD")
            case .proceed:
                self.modifierWait = nil
                do {
                    try self.insert(pending.params) { value in pending.completions.forEach { $0(value) } }
                } catch {
                    self.targets.removeValue(forKey: pending.token)
                    let value: [String: Any] = ["outcome": "notInserted", "reason": (error as? InputFailure)?.code ?? "INVALID_ARGUMENTS"]
                    self.operations[pending.operation] = OperationResult(fingerprint: pending.fingerprint, result: value)
                    pending.completions.forEach { $0(value) }
                }
            }
        }
    }
    func insert(_ params: [String: Any], completion: @escaping ([String: Any]) -> Void) throws {
        let p = try arguments(params, keys: ["targetId", "sessionId", "operationId", "text"])
        let token = try uuid(p["targetId"]); let operation = try identifier(p["operationId"])
        let session = try identifier(p["sessionId"])
        guard let text = p["text"] as? String, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf16.count <= 8192, !text.contains("\0") else { throw InputFailure("INVALID_ARGUMENTS") }
        let fingerprint = SHA256.hash(data: Data((session + "\0" + token + "\0" + text).utf8)).map { String(format: "%02x", $0) }.joined()
        if let previous = operations[operation] {
            completion(previous.fingerprint == fingerprint ? previous.result : ["outcome": "notInserted", "reason": "OPERATION_CONFLICT"])
            return
        }
        guard operations.count < 1024 else { throw InputFailure("CAPACITY_EXCEEDED") }
        func result(_ outcome: String, _ code: String?) {
            let value: [String: Any] = ["outcome": outcome, "reason": code as Any? ?? NSNull()]
            operations[operation] = OperationResult(fingerprint: fingerprint, result: value); completion(value)
        }
        if var waiting = modifierWait {
            guard waiting.operation == operation, waiting.fingerprint == fingerprint else {
                return result("notInserted", "INSERTION_TRANSACTION_BUSY")
            }
            waiting.completions.append(completion); modifierWait = waiting
            return
        }
        guard let target = targets[token] else { return result("notInserted", "TARGET_UNAVAILABLE") }
        guard enabled else { return result("notInserted", "INPUT_BUSY") }
        guard clipboard == nil, pendingInsertion == nil else { return result("notInserted", "INSERTION_TRANSACTION_BUSY") }
        do { try revalidate(target) } catch { return result("notInserted", (error as? InputFailure)?.code ?? "TARGET_UNAVAILABLE") }
        if shortcutModifiersHeld() {
            // Carbon activates on key-down. A fast recognition result may reach paste
            // before the user releases Control/Option; wait without owning the
            // clipboard or posting an event, and revalidate the reserved target.
            modifierWait = PendingModifierWait(operation: operation, fingerprint: fingerprint, token: token,
                target: target, generation: generation, params: params,
                started: ProcessInfo.processInfo.systemUptime, completions: [completion])
            scheduleModifierWait(operation)
            return
        }
        targets.removeValue(forKey: token)
        let board = NSPasteboard.general; let originalCount = board.changeCount
        let saved: [NSPasteboardItem]
        // Target was checked above; validate again with the real transient text below.
        // A capability probe here would change the clipboard generation just saved.
        do { saved = try saveClipboard(board) }
        catch { return result("notInserted", (error as? InputFailure)?.code ?? "TARGET_UNAVAILABLE") }
        guard board.changeCount == originalCount else { return result("notInserted", "CLIPBOARD_CHANGED") }
        guard let source = CGEventSource(stateID: .combinedSessionState),
              let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: false) else {
            return result("notInserted", "PASTE_EVENT_FAILED")
        }
        down.flags = .maskCommand
        // End the synthesized chord on V-up. Keeping Command on both events
        // leaves Quartz reporting it held after paste, so the next insertion
        // waits for a physical release that will never arrive.
        // The modifier guards before posting still protect real held keys.
        up.flags = []
        // Declare the type while taking ownership, so setString only supplies data for that
        // generation. Never adopt a later observed count that could belong to another writer.
        let ownedCount = board.declareTypes([.string, NSPasteboard.PasteboardType("org.nspasteboard.TransientType")], owner: nil)
        clipboard = ClipboardLease(owner: ownedCount, items: saved)
        guard board.changeCount == ownedCount else { restoreClipboard(); return result("notInserted", "CLIPBOARD_CHANGED") }
        guard board.setString(text, forType: .string) else {
            let reason = board.changeCount == ownedCount ? "PASTEBOARD_WRITE_FAILED" : "CLIPBOARD_CHANGED"
            restoreClipboard(); return result("notInserted", reason)
        }
        guard board.changeCount == ownedCount else { restoreClipboard(); return result("notInserted", "CLIPBOARD_CHANGED") }
        let proof: InsertionProof?
        do {
            try revalidate(target)
            proof = insertionProof(target.snapshot, text: text)
            try revalidate(target)
        } catch { restoreClipboard(); return result("notInserted", "TARGET_CHANGED") }
        guard board.changeCount == clipboard?.owner else { restoreClipboard(); return result("notInserted", "CLIPBOARD_CHANGED") }
        guard !shortcutModifiersHeld() else {
            restoreClipboard(); return result("notInserted", "MODIFIERS_HELD")
        }
        // Reserve the result before the first irreversible event. Posting is not an editor acknowledgement.
        operations[operation] = OperationResult(fingerprint: fingerprint,
            result: ["outcome": "partialOrUnknown", "reason": "DELIVERY_UNCONFIRMED"])
        pendingInsertion = PendingInsertion(operation: operation, fingerprint: fingerprint, target: target, proof: proof,
            generation: generation, applicationEpoch: applicationEpoch, started: ProcessInfo.processInfo.systemUptime,
            completion: completion)
        target.deliveryStarted = true
        down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        scheduleConfirmation(operation)
    }

    private func selectedRange(_ value: CFTypeRef?) -> CFRange? {
        guard let value else { return nil }
        guard CFGetTypeID(value) == AXValueGetTypeID() else { return nil }
        let axValue = value as! AXValue
        guard AXValueGetType(axValue) == .cfRange else { return nil }
        var range = CFRange()
        guard AXValueGetValue(axValue, .cfRange, &range), range.location >= 0, range.length >= 0 else { return nil }
        return range
    }
    private func boundedValue(_ element: AXUIElement) -> [UInt16]? {
        guard let raw = attribute(element, kAXValueAttribute), CFGetTypeID(raw) == CFStringGetTypeID() else { return nil }
        let string = raw as! CFString
        let count = CFStringGetLength(string)
        guard count <= Self.maximumConfirmationUTF16 else { return nil }
        var units = [UInt16](repeating: 0, count: count)
        if count > 0 {
            units.withUnsafeMutableBufferPointer { buffer in
                CFStringGetCharacters(string, CFRange(location: 0, length: count), buffer.baseAddress!)
            }
        }
        return units
    }
    private func insertionProof(_ target: CapturedTarget, text: String) -> InsertionProof? {
        guard target.selectionAttribute == kAXSelectedTextRangeAttribute,
              let selection = target.selection, let range = selectedRange(selection), let before = boundedValue(target.element),
              range.location <= before.count, range.length <= before.count - range.location else { return nil }
        let inserted = Array(text.utf16)
        guard before.count - range.length + inserted.count <= Self.maximumConfirmationUTF16 else { return nil }
        var expected = before
        expected.replaceSubrange(range.location..<(range.location + range.length), with: inserted)
        // An unchanged value cannot prove that paste happened, even if the selection collapses.
        guard expected != before else { return nil }
        return InsertionProof(expectedValue: expected, expectedCaret: range.location + inserted.count)
    }
    private func scheduleConfirmation(_ operation: String) {
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(40)) { [weak self] in
            guard let self, self.pendingInsertion?.operation == operation else { return }
            self.confirmInsertion()
        }
    }
    private func confirmationTarget(_ pending: PendingInsertion) -> CapturedTarget? {
        guard enabled, generation == pending.generation, applicationEpoch == pending.applicationEpoch,
              !pending.target.focusChanged, clipboard?.owner == NSPasteboard.general.changeCount,
              // TextEdit can briefly exceed 20 ms while processing a paste. A
              // premature AX timeout permanently loses confirmation even when
              // the text lands; keep the target/clipboard checks and bounded
              // proof deadline, but use the observer's 0.2 s AX budget.
              let now = try? current(timeout: 0.2) else { return nil }
        let original = pending.target.snapshot
        guard now.pid == original.pid, now.launched == original.launched,
              CFEqual(now.window, original.window), CFEqual(now.element, original.element),
              !pending.target.focusChanged, applicationEpoch == pending.applicationEpoch else { return nil }
        return now
    }
    private func confirmInsertion() {
        guard var pending = pendingInsertion else { return }
        let elapsed = ProcessInfo.processInfo.systemUptime - pending.started
        if elapsed >= MacPasteDeliveryPolicy.clipboardHold {
            // AX text proof is optional: rich-text/opaque editors do not expose it.
            let continuous = !pending.target.focusChanged && confirmationTarget(pending) != nil
            let outcome = MacPasteDeliveryPolicy.outcome(textConfirmed: false, eventPosted: true,
                targetContinuous: continuous, clipboardOwned: clipboard?.owner == NSPasteboard.general.changeCount)
            finishInsertion(confirmed: false, submitted: outcome == "submitted"); return
        }
        if !pending.continuityLost, let proof = pending.proof {
            if let now = confirmationTarget(pending) {
                let value = boundedValue(now.element)
                if let after = confirmationTarget(pending) {
                    if value == proof.expectedValue, after.selectionAttribute == kAXSelectedTextRangeAttribute,
                       let selection = selectedRange(after.selection), selection.location == proof.expectedCaret, selection.length == 0,
                       boundedValue(after.element) == proof.expectedValue,
                       !IsSecureEventInputEnabled(), clipboard?.owner == NSPasteboard.general.changeCount,
                       ProcessInfo.processInfo.systemUptime - pending.started < MacPasteDeliveryPolicy.clipboardHold {
                        finishInsertion(confirmed: true); return
                    }
                } else {
                    pending.continuityLost = true
                    pendingInsertion = pending
                }
            } else {
                pending.continuityLost = true
                pendingInsertion = pending
            }
        }
        // Keep the clipboard available for 0.8 s, including opaque editors.
        // Never retry the paste event: it may already have been applied.
        scheduleConfirmation(pending.operation)
    }
    private func finishInsertion(confirmed: Bool, submitted: Bool = false) {
        guard let pending = pendingInsertion else { return }
        pendingInsertion = nil
        let code: Any = confirmed || submitted ? NSNull() : "DELIVERY_UNCONFIRMED"
        let value: [String: Any] = ["outcome": confirmed ? "inserted" : submitted ? "submitted" : "partialOrUnknown", "reason": code]
        operations[pending.operation] = OperationResult(fingerprint: pending.fingerprint, result: value)
        restoreClipboard()
        pending.completion(value)
    }
    func shutdown() {
        stopShortcutCapture()
        finishModifierWait(reason: "INPUT_BUSY")
        finishInsertion(confirmed: false)
        stopHotkey(); if let handler { RemoveEventHandler(handler) }; handler = nil
        enabled = false; targets.removeAll(); restoreClipboard()
        stopFocusTracking()
        if let workspaceObserver { NSWorkspace.shared.notificationCenter.removeObserver(workspaceObserver) }
        workspaceObserver = nil
    }
}

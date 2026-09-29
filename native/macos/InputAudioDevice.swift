import CoreAudio
import Foundation

// Device identity stays inside the helper; no device name or UID crosses IPC.
enum InputAudioDevice {
    static func currentUID() throws -> String {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var device = kAudioObjectUnknown
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr,
              device != kAudioObjectUnknown else { throw InputFailure("AUDIO_DEVICE_UNAVAILABLE") }
        address.mSelector = kAudioDevicePropertyDeviceUID
        var uid: CFString?
        size = UInt32(MemoryLayout<CFString?>.size)
        let status = withUnsafeMutablePointer(to: &uid) {
            AudioObjectGetPropertyData(device, &address, 0, nil, &size, $0)
        }
        guard status == noErr, let uid, !(uid as String).isEmpty else { throw InputFailure("AUDIO_DEVICE_UNAVAILABLE") }
        return uid as String
    }
    static func matches(_ uid: String) -> Bool { (try? currentUID()) == uid }
}

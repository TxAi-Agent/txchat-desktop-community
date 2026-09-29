import AppKit
import Darwin
import Foundation

let instanceID = UUID().uuidString.lowercased()
#if arch(arm64)
let architecture = "arm64"
#else
let architecture = "x64"
#endif
signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
var input: InputService!
let audio = AudioService()
input = InputService(instanceID: instanceID) { event in
    do { try writeResponse(event) } catch { audio.shutdown(); input.shutdown(); exit(1) }
}
signal(SIGTERM, SIG_IGN)
let termination = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
termination.setEventHandler { audio.shutdown(); input.shutdown(); exit(0) }
termination.resume()

// AppKit/AX and hotkey callbacks stay on the main run loop; stdin never blocks it.
DispatchQueue.global(qos: .userInitiated).async {
    do {
        while let header = try readExactly(4, allowBoundaryEOF: true) {
            let length = header.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            guard length > 0 && length <= maximumFrameBytes,
                  let body = try readExactly(Int(length)) else { throw HostFailure.invalidFrame }
            let request = try parseRequest(body)
            DispatchQueue.main.sync {
                var response: [String: Any] = ["v": 1, "id": request.id]
                do {
                    if request.version != 1 { throw InputFailure("PROTOCOL_MISMATCH") }
                    if request.method == "insertText" {
                        // Release the main run loop and stdin reader while the editor handles paste.
                        // Request IDs allow ping/status and other replies to overtake this reply.
                        try input.insert(request.params ?? [:]) { result in
                            do { try writeResponse(["v": 1, "id": request.id, "ok": true, "result": result]) }
                            catch { audio.shutdown(); input.shutdown(); exit(1) }
                        }
                        return
                    }
                    let result: [String: Any]
                    switch request.method {
                    case "hello": result = ["protocolVersion": 1, "helperVersion": "0.1.0", "instanceId": instanceID,
                        "platform": "darwin", "arch": architecture,
                        "capabilities": ["handshake": true, "hotkey": true, "audio": true, "insertion": true]]
                    case "ping": result = ["alive": true]
                    case "shutdown": audio.shutdown(); input.shutdown(); result = ["stopping": true]
                    case "audioStatus", "requestAudioPermission", "preflightAudio", "startAudio", "stopAudio", "cancelAudio", "readAudio":
                        result = try audio.handle(request.method, params: request.params)
                    default: result = try input.handle(request.method, params: request.params)
                    }
                    response["ok"] = true; response["result"] = result
                } catch {
                    if error is HostFailure { audio.shutdown(); input.shutdown(); exit(1) }
                    response["ok"] = false; response["error"] = (error as? InputFailure)?.code ?? "INVALID_ARGUMENTS"
                }
                do { try writeResponse(response) } catch { audio.shutdown(); input.shutdown(); exit(1) }
                if request.version == 1 && request.method == "shutdown" { exit(0) }
            }
        }
        DispatchQueue.main.async { audio.shutdown(); input.shutdown(); exit(0) }
    } catch {
        let code = (error as? HostFailure)?.code ?? "IO_FAILURE"
        try? FileHandle.standardError.write(contentsOf: Data((code + "\n").utf8))
        DispatchQueue.main.async { audio.shutdown(); input.shutdown(); exit(1) }
    }
}
app.run()

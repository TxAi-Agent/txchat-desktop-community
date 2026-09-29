import AVFoundation
import AppKit
import Foundation

private struct PCMFrame { let sequence: Int; var bytes: Data }
private struct AudioBatch {
    var frames: [PCMFrame]
    let state: String
    let reason: String?
    let totalSamples: Int
}

// The callback converts and queues only. It never writes pipes, performs network I/O, or retains unbounded input.
private final class AudioPipeline {
    private let lock = NSLock()
    private let converter: AVAudioConverter
    private let sourceFormat: AVAudioFormat
    private let outputFormat: AVAudioFormat
    private let ended: () -> Void
    private let deviceUnchanged: () -> Bool
    private var queue: [PCMFrame] = []
    private var inFlightFrames = 0
    private var pending = Data()
    private var samples = 0
    private var sequence = 0
    private var recording = true
    private var failed = false
    private var reason: String?
    init(format: AVAudioFormat, deviceUnchanged: @escaping () -> Bool, ended: @escaping () -> Void) throws {
        guard format.sampleRate >= 16_000, format.sampleRate <= 192_000,
              format.channelCount > 0, format.channelCount <= 32,
              let output = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000, channels: 1, interleaved: true),
              let converter = AVAudioConverter(from: format, to: output) else { throw InputFailure("AUDIO_FORMAT_UNSUPPORTED") }
        self.converter = converter; sourceFormat = format; outputFormat = output; self.ended = ended
        self.deviceUnchanged = deviceUnchanged
        converter.primeMethod = .none
        pending.reserveCapacity(3200)
    }
    func consume(_ input: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard recording else { return }
        guard deviceUnchanged() else { fail("INPUT_DEVICE_CHANGED"); return }
        guard input.frameLength <= 16_384, input.format == sourceFormat else { fail("AUDIO_FORMAT_UNSUPPORTED"); return }
        if input.frameLength == 0 { return }
        let capacity = AVAudioFrameCount(ceil(Double(input.frameLength) * 16_000 / input.format.sampleRate) + 64)
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { fail("AUDIO_CONVERSION_FAILED"); return }
        var supplied = false
        // Drain retained converter output before admitting another device callback.
        for _ in 0..<8 {
            output.frameLength = 0
            var error: NSError?
            let status = converter.convert(to: output, error: &error) { _, state in
                if supplied { state.pointee = .noDataNow; return nil }
                supplied = true; state.pointee = .haveData; return input
            }
            guard error == nil, status != .error, status != .endOfStream else { fail("AUDIO_CONVERSION_FAILED"); return }
            append(output)
            if !recording { return }
            if status == .inputRanDry { return }
        }
        fail("AUDIO_CONVERSION_FAILED")
    }
    private func append(_ buffer: AVAudioPCMBuffer) {
        guard buffer.frameLength > 0, let data = buffer.int16ChannelData?[0] else { return }
        var offset = 0
        let allowed = min(Int(buffer.frameLength), 4_800_000 - samples)
        let bytes = UnsafeRawBufferPointer(start: data, count: allowed * 2)
        while offset < bytes.count && !failed {
            let count = min(3200 - pending.count, bytes.count - offset)
            pending.append(contentsOf: bytes[offset..<(offset + count)])
            samples += count / 2; offset += count
            if pending.count == 3200 { enqueue() }
        }
        if recording && samples == 4_800_000 {
            recording = false; reason = "AUDIO_LIMIT_REACHED"; ended()
        }
    }
    private func enqueue() {
        guard !pending.isEmpty else { return }
        guard queue.count + inFlightFrames < 20 else { fail("AUDIO_OVERFLOW"); return }
        sequence += 1
        queue.append(PCMFrame(sequence: sequence, bytes: pending))
        pending = Data(); pending.reserveCapacity(3200)
    }
    private func wipe() {
        pending.resetBytes(in: pending.startIndex..<pending.endIndex); pending.removeAll(keepingCapacity: false)
        for index in queue.indices { queue[index].bytes.resetBytes(in: queue[index].bytes.startIndex..<queue[index].bytes.endIndex) }
        queue.removeAll(keepingCapacity: false)
    }
    private func fail(_ code: String) {
        guard !failed else { return }
        recording = false; failed = true; reason = code; wipe(); ended()
    }
    func interrupt(_ code: String) { lock.lock(); defer { lock.unlock() }; fail(code) }
    func checkDevice() {
        lock.lock(); defer { lock.unlock() }
        if recording && !deviceUnchanged() { fail("INPUT_DEVICE_CHANGED") }
    }
    func finish(cancel: Bool, limit: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        if cancel { fail("AUDIO_CANCELLED"); return }
        guard recording else { return }
        recording = false
        if limit { reason = "AUDIO_LIMIT_REACHED" }
        // Signal EOF to the resampler, then enqueue every remaining whole sample and the final short frame.
        for _ in 0..<8 {
            guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: 4096) else { fail("AUDIO_CONVERSION_FAILED"); return }
            var error: NSError?
            let result = converter.convert(to: output, error: &error) { _, state in state.pointee = .endOfStream; return nil }
            guard error == nil, result != .error else { fail("AUDIO_CONVERSION_FAILED"); return }
            append(output)
            if failed { return }
            if result == .endOfStream || (result == .inputRanDry && output.frameLength == 0) { enqueue(); return }
        }
        fail("AUDIO_CONVERSION_FAILED")
    }
    func take() -> AudioBatch {
        lock.lock(); defer { lock.unlock() }
        let frames = Array(queue.prefix(4)); queue.removeFirst(frames.count)
        inFlightFrames += frames.count
        return AudioBatch(frames: frames, state: failed ? "failed" : recording ? "recording" : queue.isEmpty ? "ended" : "draining",
                          reason: reason, totalSamples: samples)
    }
    func releaseBatch(_ count: Int) { lock.lock(); defer { lock.unlock() }; inFlightFrames -= count }
    var isRecording: Bool { lock.lock(); defer { lock.unlock() }; return recording }
    deinit { wipe() }
}

// Device lifecycle is main-run-loop owned; AVAudioEngine callbacks only touch AudioPipeline's bounded state.
final class AudioService {
    private var engine: AVAudioEngine?
    private var pipeline: AudioPipeline?
    private var streamID: Int64 = 0
    private var lastID: Int64 = 0
    private var prepared: (id: Int64, uid: String)?
    private var cancelledPreparedID: Int64?
    private var canStart = true
    private var configurationObserver: NSObjectProtocol?
    private var deadline: Timer?
    func status() -> [String: Any] {
        let permission: String
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: permission = "granted"
        case .denied: permission = "denied"
        case .restricted: permission = "restricted"
        case .notDetermined: permission = "notDetermined"
        @unknown default: permission = "denied"
        }
        return ["permission": permission, "active": engine != nil, "reason": NSNull()]
    }
    func requestPermission() -> [String: Any] {
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in } // Do not block protocol/heartbeat while the user decides.
        }
        return status()
    }
    private func id(_ params: [String: Any]?) throws -> Int64 {
        guard let params, Set(params.keys) == ["streamId"], let raw = params["streamId"], type(of: raw) == Int64.self,
              let id = raw as? Int64, id > 0, id <= 2_147_483_647 else { throw InputFailure("INVALID_ARGUMENTS") }
        return id
    }
    func handle(_ method: String, params: [String: Any]?) throws -> [String: Any] {
        if method == "audioStatus" { return status() }
        if method == "requestAudioPermission" { return requestPermission() }
        let requested = try id(params)
        if method == "preflightAudio" { return try preflight(requested) }
        if method == "startAudio" { return try start(requested) }
        if method == "cancelAudio", prepared?.id == requested || cancelledPreparedID == requested {
            prepared = nil
            cancelledPreparedID = requested
            return ["streamId": requested, "stopped": true]
        }
        guard requested == streamID, let pipeline else { throw InputFailure("AUDIO_INVALID_STATE") }
        switch method {
        case "stopAudio", "cancelAudio":
            if method == "stopAudio" { pipeline.checkDevice() }
            closeDevice(); pipeline.finish(cancel: method == "cancelAudio")
            if method == "cancelAudio" { canStart = true }
            return ["streamId": requested, "stopped": true]
        case "readAudio":
            pipeline.checkDevice()
            var batch = pipeline.take()
            defer {
                for index in batch.frames.indices { batch.frames[index].bytes.resetBytes(in: batch.frames[index].bytes.startIndex..<batch.frames[index].bytes.endIndex) }
                pipeline.releaseBatch(batch.frames.count)
            }
            for index in batch.frames.indices {
                try writeAudioFrame(streamID: requested, sequence: batch.frames[index].sequence, pcm: batch.frames[index].bytes)
            }
            let result: [String: Any] = ["streamId": requested, "state": batch.state, "reason": batch.reason as Any? ?? NSNull(),
                "frameCount": batch.frames.count, "totalSamples": batch.totalSamples]
            if batch.state == "ended" || batch.state == "failed" { closeDevice(); canStart = true }
            return result
        default: throw InputFailure("UNSUPPORTED_METHOD")
        }
    }
    private func preflight(_ id: Int64) throws -> [String: Any] {
        guard id > lastID else { throw InputFailure("AUDIO_INVALID_STATE") }
        lastID = id
        prepared = nil; cancelledPreparedID = nil
        guard engine == nil, canStart else { throw InputFailure("AUDIO_BUSY") }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw InputFailure("AUDIO_PERMISSION_REQUIRED") }
        prepared = (id, try InputAudioDevice.currentUID())
        return ["streamId": id, "prepared": true]
    }
    private func start(_ id: Int64) throws -> [String: Any] {
        guard let reservation = prepared, reservation.id == id else { throw InputFailure("AUDIO_INVALID_STATE") }
        prepared = nil
        guard engine == nil, canStart else { throw InputFailure("AUDIO_BUSY") }
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else { throw InputFailure("AUDIO_PERMISSION_REQUIRED") }
        let deviceUID = reservation.uid
        guard InputAudioDevice.matches(deviceUID) else { throw InputFailure("INPUT_DEVICE_CHANGED") }
        do { return try startDevice(id, uid: deviceUID) }
        catch {
            let code = InputAudioDevice.matches(deviceUID) ? (error as? InputFailure)?.code ?? "AUDIO_DEVICE_UNAVAILABLE" : "INPUT_DEVICE_CHANGED"
            closeDevice(); pipeline?.finish(cancel: true); pipeline = nil; streamID = 0; canStart = true
            throw InputFailure(code)
        }
    }
    private func startDevice(_ id: Int64, uid deviceUID: String) throws -> [String: Any] {
        let created = AVAudioEngine()
        let input = created.inputNode
        let format = input.outputFormat(forBus: 0)
        let candidate = try AudioPipeline(format: format, deviceUnchanged: { InputAudioDevice.matches(deviceUID) }) { [weak self] in
            DispatchQueue.main.async { if self?.streamID == id { self?.closeDevice() } }
        }
        pipeline = candidate; streamID = id; engine = created; canStart = false
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in candidate.consume(buffer) }
        configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange,
            object: created, queue: .main) { [weak self] _ in
                guard self?.streamID == id, self?.engine != nil, candidate.isRecording else { return }
                candidate.interrupt(InputAudioDevice.matches(deviceUID) ? "AUDIO_INTERRUPTED" : "INPUT_DEVICE_CHANGED"); self?.closeDevice()
            }
        guard InputAudioDevice.matches(deviceUID) else { throw InputFailure("INPUT_DEVICE_CHANGED") }
        created.prepare(); try created.start()
        guard InputAudioDevice.matches(deviceUID) else { throw InputFailure("INPUT_DEVICE_CHANGED") }
        deadline = Timer.scheduledTimer(withTimeInterval: 300, repeats: false) { [weak self] _ in
            guard self?.streamID == id, self?.engine != nil else { return }
            candidate.checkDevice(); self?.closeDevice(); candidate.finish(cancel: false, limit: true)
        }
        return ["streamId": id, "sampleRate": 16_000, "channels": 1, "encoding": "pcm_s16le"]
    }
    private func closeDevice() {
        deadline?.invalidate(); deadline = nil
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }; configurationObserver = nil
        if let current = engine { engine = nil; current.inputNode.removeTap(onBus: 0); current.stop() }
    }
    func shutdown() { prepared = nil; cancelledPreparedID = nil; closeDevice(); pipeline?.finish(cancel: true); pipeline = nil; streamID = 0; canStart = true }
}

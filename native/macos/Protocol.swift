import Foundation

let maximumFrameBytes = 65_536

enum HostFailure: Error {
    case invalidFrame, invalidRequest, ioFailure

    var code: String {
        switch self {
        case .invalidFrame: return "INVALID_FRAME"
        case .invalidRequest: return "INVALID_REQUEST"
        case .ioFailure: return "IO_FAILURE"
        }
    }
}

struct Request {
    let version: Int64
    let id: String
    let method: String
    let params: [String: Any]?
}

func readExactly(_ count: Int, allowBoundaryEOF: Bool = false) throws -> Data? {
    var result = Data()
    result.reserveCapacity(count)
    while result.count < count {
        let chunk = try FileHandle.standardInput.read(upToCount: count - result.count) ?? Data()
        if chunk.isEmpty {
            if allowBoundaryEOF && result.isEmpty { return nil }
            throw HostFailure.invalidFrame
        }
        result.append(chunk)
    }
    return result
}

// The request grammar is intentionally narrower than a general JSON object.
// JSONSerialization permits trailing commas and rounds numbers through NSNumber,
// so enforce object punctuation and lexical integer syntax before decoding strings.
struct RequestParser {
    let bytes: [UInt8]
    var position = 0

    mutating func skipWhitespace() {
        while position < bytes.count && [0x20, 0x09, 0x0a, 0x0d].contains(bytes[position]) {
            position += 1
        }
    }

    mutating func consume(_ byte: UInt8) -> Bool {
        skipWhitespace()
        guard position < bytes.count && bytes[position] == byte else { return false }
        position += 1
        return true
    }

    mutating func require(_ byte: UInt8) throws {
        guard consume(byte) else { throw HostFailure.invalidRequest }
    }

    mutating func parseString() throws -> String {
        skipWhitespace()
        let start = position
        try require(0x22)
        while position < bytes.count {
            let byte = bytes[position]
            position += 1
            if byte == 0x22 {
                guard let value = try? JSONDecoder().decode(String.self, from: Data(bytes[start..<position])) else {
                    throw HostFailure.invalidRequest
                }
                return value
            }
            guard byte >= 0x20 else { throw HostFailure.invalidRequest }
            if byte == 0x5c {
                guard position < bytes.count else { throw HostFailure.invalidRequest }
                let escape = bytes[position]
                position += 1
                if escape == 0x75 {
                    guard position + 4 <= bytes.count,
                          bytes[position..<(position + 4)].allSatisfy({
                              (0x30...0x39).contains($0) || (0x41...0x46).contains($0) || (0x61...0x66).contains($0)
                          }) else { throw HostFailure.invalidRequest }
                    position += 4
                } else if ![0x22, 0x5c, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74].contains(escape) {
                    throw HostFailure.invalidRequest
                }
            }
        }
        throw HostFailure.invalidRequest
    }

    mutating func parseVersion() throws -> Int64 {
        skipWhitespace()
        let start = position
        if position < bytes.count && bytes[position] == 0x2d { position += 1 }
        guard position < bytes.count && (0x30...0x39).contains(bytes[position]) else {
            throw HostFailure.invalidRequest
        }
        if bytes[position] == 0x30 {
            position += 1
        } else {
            while position < bytes.count && (0x30...0x39).contains(bytes[position]) { position += 1 }
        }
        // Fractional/exponent tokens cannot be followed by an object delimiter,
        // and are rejected by the enclosing grammar without floating-point conversion.
        guard let value = Int64(String(decoding: bytes[start..<position], as: UTF8.self)),
              (-9_007_199_254_740_991...9_007_199_254_740_991).contains(value) else {
            throw HostFailure.invalidRequest
        }
        return value
    }

    mutating func parseValue(depth: Int = 0) throws -> Any {
        guard depth < 8 else { throw HostFailure.invalidRequest }
        skipWhitespace()
        guard position < bytes.count else { throw HostFailure.invalidRequest }
        if bytes[position] == 0x22 { return try parseString() }
        if bytes[position] == 0x7b {
            position += 1
            var object = [String: Any]()
            if consume(0x7d) { return object }
            while true {
                let key = try parseString()
                guard object[key] == nil else { throw HostFailure.invalidRequest }
                try require(0x3a)
                object[key] = try parseValue(depth: depth + 1)
                if consume(0x7d) { return object }
                try require(0x2c)
            }
        }
        if bytes[position] == 0x5b {
            position += 1
            var array = [Any]()
            if consume(0x5d) { return array }
            while true {
                guard array.count < 64 else { throw HostFailure.invalidRequest }
                array.append(try parseValue(depth: depth + 1))
                if consume(0x5d) { return array }
                try require(0x2c)
            }
        }
        for (word, value) in [("true", true), ("false", false)] {
            let token = Array(word.utf8)
            if bytes[position...].starts(with: token) { position += token.count; return value }
        }
        // Protocol arguments contain only strings, integers, booleans, arrays and objects.
        return try parseVersion()
    }

    mutating func parse() throws -> Request {
        guard let object = try parseValue() as? [String: Any] else { throw HostFailure.invalidRequest }
        skipWhitespace()
        guard position == bytes.count, let rawVersion = object["v"], type(of: rawVersion) == Int64.self, let version = rawVersion as? Int64,
              let id = object["id"] as? String, let method = object["method"] as? String,
              (1...64).contains(id.utf8.count), id.utf8.allSatisfy({
                  (0x41...0x5a).contains($0) || (0x61...0x7a).contains($0) || (0x30...0x39).contains($0) || $0 == 0x5f || $0 == 0x2d
              }) else { throw HostFailure.invalidRequest }
        let withParams = ["beginShortcutCapture", "endShortcutCapture", "shortcutKeyLabel", "configure", "releaseTarget", "insertText", "preflightAudio", "startAudio", "stopAudio", "cancelAudio", "readAudio"].contains(method)
        let keys: Set<String> = withParams ? ["v", "id", "method", "params"] : ["v", "id", "method"]
        guard Set(object.keys) == keys else { throw HostFailure.invalidRequest }
        let params = object["params"] as? [String: Any]
        if withParams && params == nil { throw HostFailure.invalidRequest }
        return Request(version: version, id: id, method: method, params: params)
    }
}

func parseRequest(_ data: Data) throws -> Request {
    guard String(data: data, encoding: .utf8) != nil else { throw HostFailure.invalidRequest }
    var parser = RequestParser(bytes: Array(data))
    return try parser.parse()
}

let outputLock = NSLock()
func writeResponse(_ response: [String: Any]) throws {
    outputLock.lock(); defer { outputLock.unlock() }
    let body = try JSONSerialization.data(withJSONObject: response, options: [.sortedKeys])
    guard !body.isEmpty && body.count <= maximumFrameBytes else { throw HostFailure.ioFailure }
    let length = UInt32(body.count)
    let header = Data([UInt8((length >> 24) & 255), UInt8((length >> 16) & 255),
                       UInt8((length >> 8) & 255), UInt8(length & 255)])
    try FileHandle.standardOutput.write(contentsOf: header + body)
}

func writeAudioFrame(streamID: Int64, sequence: Int, pcm: Data) throws {
    guard !pcm.isEmpty, pcm.count <= 3200, pcm.count % 2 == 0 else { throw HostFailure.ioFailure }
    outputLock.lock(); defer { outputLock.unlock() }
    var frame = Data()
    func number(_ value: UInt32) { var big = value.bigEndian; withUnsafeBytes(of: &big) { frame.append(contentsOf: $0) } }
    number(UInt32(16 + pcm.count)); frame.append(contentsOf: [0x54, 0x58, 0x41, 0x31])
    number(UInt32(streamID)); number(UInt32(sequence)); number(UInt32(pcm.count / 2)); frame.append(pcm)
    defer { frame.resetBytes(in: frame.startIndex..<frame.endIndex) }
    try FileHandle.standardOutput.write(contentsOf: frame)
}

using System.Buffers.Binary;
using System.IO;
using System.Text;
using System.Text.Json;

internal sealed record Request(long Version, string Id, string Method, JsonElement? Parameters);
internal sealed record Configuration(bool Enabled, string Binding, int Generation, int[] ExcludedPids);
internal sealed record Insertion(string TargetId, string SessionId, string OperationId, string Text);
internal sealed class HostFailure(string code) : Exception { internal string Code { get; } = code; }
internal sealed class CommandFailure(string code) : Exception { internal string Code { get; } = code; }

internal static class Protocol
{
    internal const int MaximumFrameBytes = 65_536;
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);
    private static readonly HashSet<string> ParameterMethods =
        ["configure", "releaseTarget", "insertText", "preflightAudio", "startAudio", "stopAudio", "cancelAudio", "readAudio"];

    internal static Request? ReadRequest(Stream input)
    {
        byte[]? header = ReadExactly(input, 4, true);
        if (header is null) return null;
        uint length = BinaryPrimitives.ReadUInt32BigEndian(header);
        if (length is 0 or > MaximumFrameBytes) throw new HostFailure("INVALID_FRAME");
        try
        {
            using var document = JsonDocument.Parse(StrictUtf8.GetString(ReadExactly(input, (int)length)!));
            JsonElement root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object) throw new HostFailure("INVALID_REQUEST");
            ValidateUniqueKeys(root);
            if (!root.TryGetProperty("method", out var method) || method.ValueKind != JsonValueKind.String)
                throw new HostFailure("INVALID_REQUEST");
            string name = method.GetString()!;
            string[] expected = ParameterMethods.Contains(name) ? ["v", "id", "method", "params"] : ["v", "id", "method"];
            if (!Keys(root, expected) || !Integer(root.GetProperty("v"), -9_007_199_254_740_991, 9_007_199_254_740_991, out long version)
                || !SafeId(root.GetProperty("id"), out string id)) throw new HostFailure("INVALID_REQUEST");
            return new Request(version, id, name, ParameterMethods.Contains(name) ? root.GetProperty("params").Clone() : null);
        }
        catch (Exception exception) when (exception is JsonException or DecoderFallbackException or InvalidOperationException or ArgumentException)
        { throw new HostFailure("INVALID_REQUEST"); }
    }

    private static byte[]? ReadExactly(Stream input, int size, bool boundary = false)
    {
        byte[] buffer = new byte[size];
        int offset = 0;
        while (offset < size)
        {
            int received = input.Read(buffer, offset, size - offset);
            if (received == 0)
            {
                if (offset == 0 && boundary) return null;
                throw new HostFailure("INVALID_FRAME");
            }
            offset += received;
        }
        return buffer;
    }

    private static void ValidateUniqueKeys(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (var property in value.EnumerateObject())
            {
                if (!names.Add(property.Name)) throw new HostFailure("INVALID_REQUEST");
                ValidateUniqueKeys(property.Value);
            }
        }
        else if (value.ValueKind == JsonValueKind.Array)
            foreach (var child in value.EnumerateArray()) ValidateUniqueKeys(child);
        else if (value.ValueKind == JsonValueKind.String && !ValidUtf16(value.GetString()!))
            throw new HostFailure("INVALID_REQUEST");
    }

    private static bool Keys(JsonElement value, params string[] expected) =>
        value.ValueKind == JsonValueKind.Object && value.EnumerateObject().Select(p => p.Name).ToHashSet(StringComparer.Ordinal).SetEquals(expected);

    private static bool Integer(JsonElement value, long minimum, long maximum, out long result)
    {
        result = 0;
        if (value.ValueKind != JsonValueKind.Number) return false;
        string raw = value.GetRawText();
        if (raw.Contains('.') || raw.Contains('e') || raw.Contains('E')) return false;
        return value.TryGetInt64(out result) && result >= minimum && result <= maximum;
    }

    private static bool SafeId(JsonElement value, out string result)
    {
        result = value.ValueKind == JsonValueKind.String ? value.GetString()! : "";
        return result.Length is >= 1 and <= 64 && result.All(c => c is >= 'A' and <= 'Z' or >= 'a' and <= 'z' or >= '0' and <= '9' or '_' or '-');
    }

    private static string Uuid(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.String || !Guid.TryParseExact(value.GetString(), "D", out Guid id))
            throw new CommandFailure("INVALID_ARGUMENTS");
        return id.ToString();
    }

    private static JsonElement Parameters(Request request, params string[] fields)
    {
        if (request.Parameters is not { } parameters || !Keys(parameters, fields)) throw new CommandFailure("INVALID_ARGUMENTS");
        return parameters;
    }

    internal static Configuration Configuration(Request request)
    {
        var args = Parameters(request, "enabled", "binding", "generation", "excludedPids");
        var enabled = args.GetProperty("enabled");
        var binding = args.GetProperty("binding");
        var pids = args.GetProperty("excludedPids");
        if (enabled.ValueKind is not (JsonValueKind.True or JsonValueKind.False)
            || binding.ValueKind != JsonValueKind.String || !ShortcutBinding.IsValid(binding.GetString()!)
            || !Integer(args.GetProperty("generation"), 1, int.MaxValue, out long generation)
            || pids.ValueKind != JsonValueKind.Array || pids.GetArrayLength() is < 1 or > 64)
            throw new CommandFailure("INVALID_ARGUMENTS");
        var excluded = new List<int>();
        foreach (var pid in pids.EnumerateArray())
        {
            if (!Integer(pid, 1, int.MaxValue, out long number)) throw new CommandFailure("INVALID_ARGUMENTS");
            excluded.Add((int)number);
        }
        return new Configuration(enabled.GetBoolean(), binding.GetString()!, (int)generation, excluded.ToArray());
    }

    internal static string TargetId(Request request) => Uuid(Parameters(request, "targetId").GetProperty("targetId"));

    internal static int StreamId(Request request)
    {
        var args = Parameters(request, "streamId");
        if (!Integer(args.GetProperty("streamId"), 1, int.MaxValue, out long streamId))
            throw new CommandFailure("INVALID_ARGUMENTS");
        return (int)streamId;
    }

    internal static Insertion Insertion(Request request)
    {
        var args = Parameters(request, "targetId", "sessionId", "operationId", "text");
        var text = args.GetProperty("text");
        if (!SafeId(args.GetProperty("sessionId"), out string sessionId) || !SafeId(args.GetProperty("operationId"), out string operationId)
            || text.ValueKind != JsonValueKind.String) throw new CommandFailure("INVALID_ARGUMENTS");
        string body = text.GetString()!;
        if (body.Length is < 1 or > 8192 || body.Contains('\0') || !ValidUtf16(body)) throw new CommandFailure("INVALID_ARGUMENTS");
        return new Insertion(Uuid(args.GetProperty("targetId")), sessionId, operationId, body);
    }

    private static bool ValidUtf16(string text)
    {
        for (int index = 0; index < text.Length; index++)
        {
            char value = text[index];
            if (char.IsHighSurrogate(value))
            { if (++index == text.Length || !char.IsLowSurrogate(text[index])) return false; }
            else if (char.IsLowSurrogate(value)) return false;
        }
        return true;
    }
}

internal sealed class FrameWriter(Stream stream) : IDisposable
{
    private readonly object gate = new();
    internal void Error(string id, string code) => Write(new { v = 1, id, ok = false, error = code });
    internal void Result(string id, object result) => Write(new { v = 1, id, ok = true, result });
    internal void WriteAudio(int streamId, uint sequence, ReadOnlySpan<byte> pcm)
    {
        if (streamId <= 0 || sequence == 0 || pcm.Length is < 2 or > 3200 || (pcm.Length & 1) != 0)
            throw new HostFailure("IO_FAILURE");
        // No second PCM copy: only the framing header is assembled here.
        Span<byte> header = stackalloc byte[20];
        BinaryPrimitives.WriteUInt32BigEndian(header, checked((uint)(16 + pcm.Length)));
        "TXA1"u8.CopyTo(header[4..]);
        BinaryPrimitives.WriteUInt32BigEndian(header[8..], (uint)streamId);
        BinaryPrimitives.WriteUInt32BigEndian(header[12..], sequence);
        BinaryPrimitives.WriteUInt32BigEndian(header[16..], (uint)(pcm.Length / 2));
        lock (gate)
        {
            stream.Write(header); stream.Write(pcm); stream.Flush();
        }
    }
    internal void Write(object response)
    {
        byte[] body = JsonSerializer.SerializeToUtf8Bytes(response);
        if (body.Length is 0 or > Protocol.MaximumFrameBytes) throw new HostFailure("IO_FAILURE");
        lock (gate)
        {
            Span<byte> header = stackalloc byte[4];
            BinaryPrimitives.WriteUInt32BigEndian(header, (uint)body.Length);
            stream.Write(header); stream.Write(body); stream.Flush();
        }
    }
    public void Dispose() => stream.Dispose();
}

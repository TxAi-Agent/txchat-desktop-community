using System.Runtime.InteropServices;

// Writes only our dictated text. This adapter never snapshots or restores the
// previous clipboard, and the owner HWND must be dedicated to this thread's writer.
internal sealed class NativeClipboardText(nint owner) : IClipboardText
{
    private const uint UnicodeText = 13, MoveableZeroed = 0x42;
    private const int MaximumBytes = 2 * 1024 * 1024; // Includes CRLF and final NUL.
    private const string WriteFailed = "PASTEBOARD_WRITE_FAILED";
    private readonly uint threadId = GetCurrentThreadId();
    private long generation;
    private ClipboardTextLease? currentLease;
    private byte[]? currentText;
    private nuint currentAllocation;
    private uint verifiedSequence;

    public ClipboardTextWrite Write(string text)
    {
        RequireOwnerThread();
        ForgetLease();
        if (generation == long.MaxValue) throw new PasteFailure(WriteFailed);
        long nextGeneration = ++generation;
        byte[]? encoded = null;
        nint memory = 0;
        try
        {
            // All payload allocation, validation, encoding, locking and copying
            // succeed before EmptyClipboard can destroy the previous contents.
            encoded = Encode(text);
            memory = GlobalAlloc(MoveableZeroed, (nuint)encoded.Length);
            if (memory == 0) throw new PasteFailure(WriteFailed);
            nuint allocation = GlobalSize(memory);
            if (allocation < (nuint)encoded.Length || allocation > MaximumBytes)
                throw new PasteFailure(WriteFailed);
            nint pointer = GlobalLock(memory);
            if (pointer == 0) throw new PasteFailure(WriteFailed);
            bool unlocked;
            try { Marshal.Copy(encoded, 0, pointer, encoded.Length); }
            finally { unlocked = Unlock(memory); }
            if (!unlocked) throw new PasteFailure(WriteFailed);

            if (!OpenClipboard(owner)) throw new ClipboardBusyException();
            bool written = false, closed;
            try
            {
                if (EmptyClipboard() && SetClipboardData(UnicodeText, memory) != 0)
                {
                    memory = 0; // Windows owns it now; never free or modify it.
                    written = true;
                }
            }
            finally { closed = CloseClipboard(); }

            // Close publishes formats and may advance the sequence. Only record
            // the lease after closing; no failure path retries a destructive write.
            uint sequence = GetClipboardSequenceNumber();
            if (!written || !closed || sequence == 0 || GetClipboardOwner() != owner
                || GetClipboardSequenceNumber() != sequence)
                return new(false, null, WriteFailed);

            var lease = new ClipboardTextLease(nextGeneration, sequence);
            currentText = encoded; encoded = null;
            currentAllocation = allocation;
            verifiedSequence = sequence;
            currentLease = lease;
            return new(true, lease, null);
        }
        catch (OutOfMemoryException) { ForgetLease(); throw new PasteFailure(WriteFailed); }
        finally
        {
            if (memory != 0) GlobalFree(memory); // Only an untransferred HGLOBAL.
            if (encoded is not null) Array.Clear(encoded);
        }
    }

    public bool Owns(ClipboardTextLease lease)
    {
        RequireOwnerThread();
        byte[]? expected = currentText;
        if (!ReferenceEquals(currentLease, lease) || lease.Generation != generation
            || expected is null) return false;
        if (GetClipboardOwner() != owner) return LostLease();
        uint sequence = GetClipboardSequenceNumber();
        if (sequence == 0) return LostLease();
        if (sequence == verifiedSequence)
        {
            if (GetClipboardOwner() == owner && GetClipboardSequenceNumber() == sequence) return true;
            return LostLease();
        }

        // A system-generated ANSI/OEM representation can change the sequence.
        // Read only OUR Unicode payload, after checking its owner under the lock.
        // A different owner is rejected without retrieving any clipboard data.
        if (!OpenClipboard(owner)) throw new ClipboardBusyException();
        bool matches = false, closed;
        uint checkedSequence = 0;
        try
        {
            if (GetClipboardOwner() == owner && ReferenceEquals(currentLease, lease))
            {
                matches = Matches(expected, currentAllocation);
                checkedSequence = GetClipboardSequenceNumber();
                matches &= checkedSequence != 0 && GetClipboardOwner() == owner;
            }
        }
        finally { closed = CloseClipboard(); }
        if (!closed || !matches || GetClipboardOwner() != owner
            || GetClipboardSequenceNumber() != checkedSequence) return LostLease();
        verifiedSequence = checkedSequence;
        return true;
    }

    private void RequireOwnerThread()
    {
        if (owner == 0 || GetCurrentThreadId() != threadId
            || GetWindowThreadProcessId(owner, out uint process) != threadId
            || process != GetCurrentProcessId()) throw new PasteFailure(WriteFailed);
    }

    private bool LostLease() { ForgetLease(); return false; }
    private void ForgetLease()
    {
        currentLease = null; verifiedSequence = 0; currentAllocation = 0;
        if (currentText is { } text) Array.Clear(text);
        currentText = null;
    }

    private static byte[] Encode(string text)
    {
        if (text is null || text.Length > MaximumBytes / 2 - 1)
            throw new PasteFailure(WriteFailed);
        int units = 0;
        for (int i = 0; i < text.Length; i++)
        {
            char value = text[i];
            if (value == '\0') throw new PasteFailure(WriteFailed);
            if (value is '\r' or '\n')
            {
                units += 2;
                if (value == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
            }
            else if (char.IsHighSurrogate(value))
            {
                if (i + 1 >= text.Length || !char.IsLowSurrogate(text[i + 1]))
                    throw new PasteFailure(WriteFailed);
                i++; units += 2;
            }
            else
            {
                if (char.IsLowSurrogate(value)) throw new PasteFailure(WriteFailed);
                units++;
            }
            if (units > MaximumBytes / 2 - 1) throw new PasteFailure(WriteFailed);
        }
        var bytes = new byte[(units + 1) * 2];
        int offset = 0;
        for (int i = 0; i < text.Length; i++)
        {
            char value = text[i];
            if (value is '\r' or '\n')
            {
                bytes[offset++] = 13; bytes[offset++] = 0;
                bytes[offset++] = 10; bytes[offset++] = 0;
                if (value == '\r' && i + 1 < text.Length && text[i + 1] == '\n') i++;
            }
            else
            {
                bytes[offset++] = (byte)value;
                bytes[offset++] = (byte)(value >> 8);
            }
        }
        // The zero-initialized final two bytes are the sole UTF-16 terminator.
        return bytes;
    }

    private static unsafe bool Matches(byte[] expected, nuint allocation)
    {
        nint memory = GetClipboardData(UnicodeText);
        if (memory == 0 || GlobalSize(memory) != allocation || allocation > MaximumBytes
            || allocation < (nuint)expected.Length) return false;
        nint pointer = GlobalLock(memory);
        if (pointer == 0) return false;
        bool matches, unlocked;
        try
        {
            var actual = new ReadOnlySpan<byte>((void*)pointer, (int)allocation);
            matches = actual[..expected.Length].SequenceEqual(expected)
                && actual[expected.Length..].IndexOfAnyExcept((byte)0) < 0;
        }
        finally { unlocked = Unlock(memory); }
        return matches && unlocked;
    }

    private static bool Unlock(nint memory)
    {
        // FALSE with NO_ERROR means the last lock was successfully released.
        Marshal.SetLastPInvokeError(0);
        return GlobalUnlock(memory) || Marshal.GetLastPInvokeError() == 0;
    }

    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool OpenClipboard(nint owner);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool CloseClipboard();
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool EmptyClipboard();
    [DllImport("user32.dll")] private static extern nint GetClipboardOwner();
    [DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll", SetLastError = true)] private static extern nint GetClipboardData(uint format);
    [DllImport("user32.dll", SetLastError = true)] private static extern nint SetClipboardData(uint format, nint data);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint process);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] private static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalAlloc(uint flags, nuint bytes);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalFree(nint memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nint GlobalLock(nint memory);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GlobalUnlock(nint memory);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern nuint GlobalSize(nint memory);
}

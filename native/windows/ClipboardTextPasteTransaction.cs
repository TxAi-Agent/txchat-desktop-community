internal sealed record ClipboardTextLease(long Generation, uint Sequence);
internal sealed record ClipboardTextWrite(bool Written, ClipboardTextLease? Lease, string? Reason);
internal interface IClipboardText
{
    ClipboardTextWrite Write(string text);
    bool Owns(ClipboardTextLease lease);
}

// Windows clipboard + one Ctrl+V. Recognition text remains on the clipboard
// so a receiver that reads later still sees the submitted payload.
internal sealed class ClipboardTextPasteTransaction(IClipboardText board, Func<int, Task>? delay = null) : IDisposable
{
    private readonly Func<int, Task> delay = delay ?? (milliseconds => Task.Delay(milliseconds));
    private bool active, cancelled, disposed;
    private Task? pending;
    internal bool Busy => active;

    internal Task<InsertResult> ExecuteAsync(string text, Func<string?> validate,
        Func<uint> send)
    {
        if (disposed) return Task.FromResult(new InsertResult("notInserted", "CANCELLED"));
        if (active) return Task.FromResult(new InsertResult("notInserted", "INSERTION_TRANSACTION_BUSY"));
        active = true; cancelled = false;
        var run = RunAsync(text, validate, send);
        pending = run;
        return run;
    }

    private async Task<InsertResult> RunAsync(string text, Func<string?> validate,
        Func<uint> send)
    {
        bool attempted = false;
        try
        {
            ClipboardTextWrite written;
            for (int attempt = 0; ; attempt++)
            {
                if (cancelled || disposed) return new("notInserted", "CANCELLED");
                string? rejection = validate();
                if (rejection is not null) return new("notInserted", rejection);
                try { written = board.Write(text); break; }
                catch (ClipboardBusyException) when (attempt < 3) { await delay(25); }
            }
            if (!written.Written || written.Lease is null)
                return new("notInserted", written.Reason ?? "PASTEBOARD_WRITE_FAILED");
            if (cancelled || disposed) return new("notInserted", "CANCELLED");
            string? changed = validate();
            if (changed is not null) return new("notInserted", changed);
            if (!board.Owns(written.Lease)) return new("notInserted", "CLIPBOARD_CHANGED");
            attempted = true; // A failed/partial send is never replayed.
            uint sent = send();
            // Completion acknowledges the one foreground paste submission.
            // Editor readback/caret changes and later clipboard activity cannot
            // undo that submission. Never claim text proof or resend the keys.
            return sent == 4 ? new("submitted", null)
                : new("partialOrUnknown", "DELIVERY_UNCONFIRMED");
        }
        catch (PasteFailure failure)
        { return new(attempted ? "partialOrUnknown" : "notInserted", attempted ? "DELIVERY_UNCONFIRMED" : failure.Code); }
        catch
        { return new(attempted ? "partialOrUnknown" : "notInserted", attempted ? "DELIVERY_UNCONFIRMED" : "PASTEBOARD_WRITE_FAILED"); }
        finally { active = false; }
    }

    internal void Cancel() => cancelled = true;
    internal async Task ShutdownAsync() { Cancel(); if (pending is { } run) await run; }
    public void Dispose() { disposed = true; Cancel(); }
}

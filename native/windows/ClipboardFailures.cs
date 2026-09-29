internal sealed class PasteFailure(string code) : Exception
{ internal string Code { get; } = code; }
internal sealed class ClipboardBusyException : Exception { }

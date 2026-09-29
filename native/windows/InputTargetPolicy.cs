using System.Text.Json.Serialization;

internal sealed record InsertResult(string outcome, string? reason,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? warning = null);

internal static class InputTargetPolicy
{
    internal static bool IsOwnInjection(uint flags, nuint extraInfo, nuint ownMarker)
        => (flags & 0x12) != 0 && extraInfo == ownMarker;

    internal static bool ActivationMatches(nint window, int pid, long focusEpoch, long interactionEpoch,
        nint currentWindow, int currentPid, long currentFocusEpoch, long currentInteractionEpoch)
        => window != 0 && window == currentWindow && pid == currentPid
            && focusEpoch == currentFocusEpoch && interactionEpoch == currentInteractionEpoch;

    // This decides whether body/selection proof is safe, not whether an ordinary
    // window may receive the user-approved clipboard paste.
    internal static bool RequiresOpaqueFocus(bool hasElement, bool? keyboardFocus, bool? focusable,
        bool? password, int[]? runtimeId) => !hasElement || keyboardFocus is not true || focusable is not true
            || password is not false || runtimeId is not { Length: > 0 };

    internal static bool InvalidatesKey(bool down, bool physical, bool activationChord, bool chordModifier)
        => down && physical && !activationChord && !chordModifier;

    internal static bool InvalidatesPointer(int message, bool physical, bool buttonsHeld)
        => physical && (message is 0x0201 or 0x0202 or 0x0204 or 0x0205 or 0x0207 or 0x0208 or 0x020A or 0x020B or 0x020C or 0x020E
            || message == 0x0200 && buttonsHeld);
    // Capability evidence, not application names or UIA role names. Explicit
    // read-only/password protection wins even when another provider disagrees.
    internal static bool Allows(bool focused, bool? password, bool? textReadOnly,
        bool? valueReadOnly, bool systemTextPaste) => focused && password is false
        && textReadOnly is not true && valueReadOnly is not true
        && (textReadOnly is false || valueReadOnly is false || systemTextPaste);

    internal static bool SameFocusNotice(nint previousWindow, int[]? previousRuntime,
        nint currentWindow, int[]? currentRuntime) => previousWindow != 0 && previousWindow == currentWindow
        && previousRuntime is { Length: > 0 } && currentRuntime is { Length: > 0 }
        && previousRuntime.SequenceEqual(currentRuntime);
}

using System.Runtime.InteropServices;

// Independently validates IPC strings; modifiers are in the same canonical order as the shared model.
internal sealed record ShortcutBinding(string Code, uint Modifiers, uint VirtualKey, uint ScanCode = 0)
{
    private static readonly string[] ModifierOrder = ["ctrl", "alt", "shift", "meta"];
    private static readonly uint[] ModifierFlags = [0x0002, 0x0001, 0x0004, 0x0008];
    private static readonly Dictionary<string, uint> Keys = new(StringComparer.Ordinal)
    {
        ["Space"] = 0x20, ["Enter"] = 0x0D, ["Tab"] = 0x09, ["Backspace"] = 0x08, ["Escape"] = 0x1B,
        ["Delete"] = 0x2E, ["Home"] = 0x24, ["End"] = 0x23, ["PageUp"] = 0x21, ["PageDown"] = 0x22,
        ["ArrowLeft"] = 0x25, ["ArrowRight"] = 0x27, ["ArrowUp"] = 0x26, ["ArrowDown"] = 0x28,
        ["Minus"] = 0xBD, ["Equal"] = 0xBB, ["BracketLeft"] = 0xDB, ["BracketRight"] = 0xDD,
        ["Backslash"] = 0xDC, ["Semicolon"] = 0xBA, ["Quote"] = 0xDE, ["Backquote"] = 0xC0,
        ["Comma"] = 0xBC, ["Period"] = 0xBE, ["Slash"] = 0xBF, ["IntlBackslash"] = 0xE2,
        ["NumpadDecimal"] = 0x6E, ["NumpadAdd"] = 0x6B, ["NumpadSubtract"] = 0x6D,
        ["NumpadMultiply"] = 0x6A, ["NumpadDivide"] = 0x6F,
        ["Insert"] = 0x2D, ["PrintScreen"] = 0x2C, ["ScrollLock"] = 0x91, ["Pause"] = 0x13,
    };
    private static readonly Dictionary<string, uint> Scans = new(StringComparer.Ordinal)
    {
        ["KeyA"] = 0x1E, ["KeyB"] = 0x30, ["KeyC"] = 0x2E, ["KeyD"] = 0x20, ["KeyE"] = 0x12,
        ["KeyF"] = 0x21, ["KeyG"] = 0x22, ["KeyH"] = 0x23, ["KeyI"] = 0x17, ["KeyJ"] = 0x24,
        ["KeyK"] = 0x25, ["KeyL"] = 0x26, ["KeyM"] = 0x32, ["KeyN"] = 0x31, ["KeyO"] = 0x18,
        ["KeyP"] = 0x19, ["KeyQ"] = 0x10, ["KeyR"] = 0x13, ["KeyS"] = 0x1F, ["KeyT"] = 0x14,
        ["KeyU"] = 0x16, ["KeyV"] = 0x2F, ["KeyW"] = 0x11, ["KeyX"] = 0x2D, ["KeyY"] = 0x15, ["KeyZ"] = 0x2C,
        ["Digit1"] = 0x02, ["Digit2"] = 0x03, ["Digit3"] = 0x04, ["Digit4"] = 0x05, ["Digit5"] = 0x06,
        ["Digit6"] = 0x07, ["Digit7"] = 0x08, ["Digit8"] = 0x09, ["Digit9"] = 0x0A, ["Digit0"] = 0x0B,
        ["Minus"] = 0x0C, ["Equal"] = 0x0D, ["BracketLeft"] = 0x1A, ["BracketRight"] = 0x1B,
        ["Backslash"] = 0x2B, ["Semicolon"] = 0x27, ["Quote"] = 0x28, ["Backquote"] = 0x29,
        ["Comma"] = 0x33, ["Period"] = 0x34, ["Slash"] = 0x35, ["IntlBackslash"] = 0x56,
        ["Numpad0"] = 0x52, ["Numpad1"] = 0x4F, ["Numpad2"] = 0x50, ["Numpad3"] = 0x51,
        ["Numpad4"] = 0x4B, ["Numpad5"] = 0x4C, ["Numpad6"] = 0x4D, ["Numpad7"] = 0x47,
        ["Numpad8"] = 0x48, ["Numpad9"] = 0x49, ["NumpadDecimal"] = 0x53,
    };
    internal static ShortcutBinding Parse(string value)
    {
        if (value == "fn") return new("Fn", 0, 0);
        if (value == "key::F8") return new("F8", 0, 0x77);
        value = value switch { "ctrl-alt-space" => "key:ctrl+alt:Space", "ctrl-shift-space" => "key:ctrl+shift:Space", _ => value };
        var parts = value.Split(':');
        if (value.Length > 80 || parts.Length != 3 || parts[0] != "key") throw new CommandFailure("INVALID_ARGUMENTS");
        var names = parts[1].Split('+');
        if (names.Length is < 1 or > 2 || names.Distinct().Count() != names.Length ||
            (names.Length == 1 && names[0] == "shift") || !ModifierOrder.Where(names.Contains).SequenceEqual(names))
            throw new CommandFailure("INVALID_ARGUMENTS");
        uint modifiers = 0;
        foreach (var name in names) modifiers |= ModifierFlags[Array.IndexOf(ModifierOrder, name)];
        string code = parts[2];
        uint key;
        if (code.Length == 4 && code.StartsWith("Key", StringComparison.Ordinal) && code[3] is >= 'A' and <= 'Z') key = code[3];
        else if (code.Length == 6 && code.StartsWith("Digit", StringComparison.Ordinal) && code[5] is >= '0' and <= '9') key = code[5];
        else if (code.Length == 7 && code.StartsWith("Numpad", StringComparison.Ordinal) && code[6] is >= '0' and <= '9') key = (uint)(0x60 + code[6] - '0');
        else if (code.StartsWith('F') && int.TryParse(code.AsSpan(1), out int number) && number is >= 1 and <= 20 && code == $"F{number}") key = (uint)(0x70 + number - 1);
        else if (code is "NumpadEnter" or "NumpadEqual" or "Clear" or "Help") return new(code, modifiers, 0);
        else if (!Keys.TryGetValue(code, out key)) throw new CommandFailure("INVALID_ARGUMENTS");
        return new(code, modifiers, key, Scans.GetValueOrDefault(code));
    }
    internal static bool IsValid(string value)
    {
        try { _ = Parse(value); return true; } catch (CommandFailure) { return false; }
    }
    internal bool IsNumericKeypad => ScanCode != 0 && Code.StartsWith("Numpad", StringComparison.Ordinal);
    internal bool IsLayoutSensitive => ScanCode != 0 && !IsNumericKeypad;
    internal static bool NumLockEnabled => (GetKeyState(0x90) & 1) != 0;
    internal ShortcutBinding Resolve(nint layout)
    {
        if (VirtualKey == 0) throw new CommandFailure("UNSUPPORTED_BINDING");
        uint key;
        if (IsNumericKeypad)
        {
            // Initial reservation. The hook's actual VK is authoritative when
            // Shift/driver/layout behavior differs from the toggle prediction.
            bool numeric = NumLockEnabled != UsesModifier(Win32.Shift);
            key = Code switch
            {
                "Numpad0" => numeric ? 0x60u : 0x2Du, "Numpad1" => numeric ? 0x61u : 0x23u,
                "Numpad2" => numeric ? 0x62u : 0x28u, "Numpad3" => numeric ? 0x63u : 0x22u,
                "Numpad4" => numeric ? 0x64u : 0x25u, "Numpad5" => numeric ? 0x65u : 0x0Cu,
                "Numpad6" => numeric ? 0x66u : 0x27u, "Numpad7" => numeric ? 0x67u : 0x24u,
                "Numpad8" => numeric ? 0x68u : 0x26u, "Numpad9" => numeric ? 0x69u : 0x21u,
                "NumpadDecimal" => numeric ? 0x6Eu : 0x2Eu,
                _ => throw new CommandFailure("UNSUPPORTED_BINDING"),
            };
        }
        else key = ScanCode == 0 ? VirtualKey : MapVirtualKeyEx(ScanCode, 3, layout);
        if (key == 0) throw new CommandFailure("UNSUPPORTED_BINDING");
        return this with { VirtualKey = key };
    }
    internal bool Matches(Win32.KeyboardHookData key)
    {
        if (ScanCode != 0) return key.ScanCode == ScanCode && (key.Flags & 1) == 0;
        if (key.VirtualKey != VirtualKey) return false;
        bool extended = (key.Flags & 1) != 0;
        // NumLock-off keypad keys share navigation VKs; never treat them as
        // the distinct physical navigation cluster (or keypad Enter as Enter).
        if (Code is "Enter") return !extended;
        if (Code is "Insert" or "Delete" or "Home" or "End" or "PageUp" or "PageDown" or
            "ArrowLeft" or "ArrowRight" or "ArrowUp" or "ArrowDown") return extended;
        return true;
    }
    internal bool UsesModifier(int key) => key switch
    { Win32.Control => (Modifiers & 2) != 0, Win32.Alt => (Modifiers & 1) != 0, Win32.Shift => (Modifiers & 4) != 0, 0x5B => (Modifiers & 8) != 0, _ => false };
    internal static nint CurrentLayout()
    {
        uint thread = GetWindowThreadProcessId(Win32.GetForegroundWindow(), out _);
        return GetKeyboardLayout(thread);
    }
    [DllImport("user32.dll")] private static extern short GetKeyState(int key);
    [DllImport("user32.dll")] private static extern uint MapVirtualKeyEx(uint code, uint type, nint layout);
    [DllImport("user32.dll")] private static extern nint GetKeyboardLayout(uint thread);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint process);
}

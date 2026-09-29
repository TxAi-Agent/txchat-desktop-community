using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

internal static class Win32
{
    internal const int Space = 0x20, Control = 0x11, Shift = 0x10, Alt = 0x12;
    // A per-process correlation marker, not an authentication boundary. It lets
    // our low-level hook leave the physical hotkey latch untouched by Ctrl+V.
    internal static readonly nuint PasteInputMarker = (nuint)System.Security.Cryptography.RandomNumberGenerator.GetInt32(1, int.MaxValue);
    internal delegate nint KeyboardCallback(int code, nint message, nint data);

    [StructLayout(LayoutKind.Sequential)]
    internal struct KeyboardHookData
    {
        internal uint VirtualKey, ScanCode, Flags, Time;
        internal nuint ExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MouseHookData
    { internal int X, Y; internal uint MouseData, Flags, Time; internal nuint ExtraInfo; }

    internal static nint NativeFocus(nint foreground)
    {
        uint thread = GetWindowThreadProcessId(foreground, out uint pid);
        var gui = new GuiThreadInfo { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        if (thread == 0 || !GetGUIThreadInfo(thread, ref gui) || gui.Focus == 0
            || GetWindowThreadProcessId(gui.Focus, out uint focusedPid) == 0 || focusedPid != pid)
            throw new CommandFailure("TARGET_UNAVAILABLE");
        return gui.Focus;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Input { internal uint Type; internal InputUnion Data; }
    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] internal KeyboardInput Keyboard;
        [FieldOffset(0)] internal MouseInput Mouse;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput { internal ushort VirtualKey, ScanCode; internal uint Flags, Time; internal nuint ExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput { internal int X, Y; internal uint MouseData, Flags, Time; internal nuint ExtraInfo; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        internal uint Size, Usage, ProcessId;
        internal nuint DefaultHeap;
        internal uint ModuleId, Threads, ParentId;
        internal int Priority;
        internal uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] internal string ExeFile;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct FileTime { internal uint Low, High; internal long Value => ((long)High << 32) | Low; }

    internal sealed record ProcessIdentity(int Pid, long Created, int Integrity);

    internal static long CreationTime(int pid)
    {
        using var process = OpenProcess(0x1000, false, checked((uint)pid));
        if (process.IsInvalid || !GetProcessTimes(process, out var creation, out _, out _, out _))
            throw new CommandFailure("TARGET_UNAVAILABLE");
        return creation.Value;
    }

    internal static Dictionary<int, int> ProcessParents()
    {
        using var snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot.IsInvalid) throw new CommandFailure("TARGET_UNAVAILABLE");
        var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>(), ExeFile = "" };
        var parents = new Dictionary<int, int>();
        if (!Process32First(snapshot, ref entry)) throw new CommandFailure("TARGET_UNAVAILABLE");
        do
        {
            if (entry.ProcessId <= int.MaxValue && entry.ParentId <= int.MaxValue)
                parents[(int)entry.ProcessId] = (int)entry.ParentId;
        } while (Process32Next(snapshot, ref entry));
        return parents;
    }

    internal static ProcessIdentity Identity(int pid)
    {
        using var process = OpenProcess(0x1000, false, checked((uint)pid));
        if (process.IsInvalid || !GetProcessTimes(process, out var creation, out _, out _, out _))
            throw new CommandFailure("TARGET_UNAVAILABLE");
        if (!OpenProcessToken(process, 0x0008, out var token)) throw new CommandFailure("PROTECTED_TARGET");
        using (token)
        {
            _ = GetTokenInformation(token, 25, 0, 0, out int length);
            if (length is < 1 or > 16384) throw new CommandFailure("PROTECTED_TARGET");
            nint buffer = Marshal.AllocHGlobal(length);
            try
            {
                if (!GetTokenInformation(token, 25, buffer, length, out _)) throw new CommandFailure("PROTECTED_TARGET");
                nint sid = Marshal.ReadIntPtr(buffer);
                nint countPointer = GetSidSubAuthorityCount(sid);
                if (countPointer == 0) throw new CommandFailure("PROTECTED_TARGET");
                byte count = Marshal.ReadByte(countPointer);
                if (count == 0) throw new CommandFailure("PROTECTED_TARGET");
                nint integrityPointer = GetSidSubAuthority(sid, (uint)(count - 1));
                if (integrityPointer == 0) throw new CommandFailure("PROTECTED_TARGET");
                int integrity = Marshal.ReadInt32(integrityPointer);
                // Medium is the highest permitted target even if someone
                // launches this helper elevated accidentally.
                if (integrity is < 0 or > 0x2000) throw new CommandFailure("PROTECTED_TARGET");
                return new ProcessIdentity(pid, creation.Value, integrity);
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
    }

    internal static bool DefaultDesktop()
    {
        using var desktop = new DesktopHandle(OpenInputDesktop(0, false, 1));
        if (desktop.IsInvalid) return false;
        var name = new StringBuilder(256);
        return GetUserObjectInformation(desktop, 2, name, (uint)(name.Capacity * 2), out _)
            && string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase);
    }

    internal static int WindowPid(nint window)
    {
        if (window == 0 || GetWindowThreadProcessId(window, out uint pid) == 0 || pid is 0 or > int.MaxValue)
            throw new CommandFailure("TARGET_UNAVAILABLE");
        return (int)pid;
    }

    internal static bool Down(int key) => (GetAsyncKeyState(key) & 0x8000) != 0;
    internal static bool ModifiersHeld() => Down(Control) || Down(Alt) || Down(Shift) || Down(0x5B) || Down(0x5C) || Down(Space);
    internal static bool MouseButtonsHeld() => Down(1) || Down(2) || Down(4) || Down(5) || Down(6);

    internal static uint SendPaste(nint expectedForeground, nint expectedFocus = 0)
    {
        var inputs = new[] { Key(Control, false), Key(0x56, false), Key(0x56, true), Key(Control, true) };
        if (GetForegroundWindow() != expectedForeground || ModifiersHeld() || !DefaultDesktop()
            || expectedFocus != 0 && NativeFocus(expectedForeground) != expectedFocus)
            throw new CommandFailure("TARGET_CHANGED");
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>());
        if (sent is > 0 and < 4)
        {
            // Release only synthetic keys whose down events were accepted, never
            // re-send V down/text. Partial delivery stays unknown regardless of
            // whether this best-effort neutralization succeeds.
            var releases = sent == 2 ? new[] { Key(0x56, true), Key(Control, true) }
                : new[] { Key(Control, true) };
            _ = SendInput((uint)releases.Length, releases, Marshal.SizeOf<Input>());
        }
        return sent;
    }

    private static Input Key(int key, bool up) => new()
    { Type = 1, Data = new InputUnion { Keyboard = new KeyboardInput { VirtualKey = (ushort)key, Flags = up ? 2u : 0u, ExtraInfo = PasteInputMarker } } };

    internal sealed record NativeTextCapability(nint Window, bool Password, bool ReadOnly, uint Start, uint End);
    internal static NativeTextCapability? FocusedNativeText(nint foreground, nint elementWindow)
    {
        uint thread = GetWindowThreadProcessId(foreground, out uint pid);
        var gui = new GuiThreadInfo { Size = (uint)Marshal.SizeOf<GuiThreadInfo>() };
        if (thread == 0 || !GetGUIThreadInfo(thread, ref gui) || gui.Focus == 0 || gui.Focus != elementWindow
            || GetWindowThreadProcessId(gui.Focus, out uint focusPid) == 0 || focusPid != pid) return null;
        var name = new StringBuilder(128);
        if (GetClassName(gui.Focus, name, name.Capacity) == 0) return null;
        string nativeClass = name.ToString();
        // These are documented Windows text-control contracts, not application
        // identities or UIA roles. A generic HWND alone conveys no capability.
        bool standardEdit = nativeClass.Equals("Edit", StringComparison.OrdinalIgnoreCase);
        bool richEdit = nativeClass.Equals("RichEdit", StringComparison.OrdinalIgnoreCase)
            || nativeClass.Equals("RichEdit20W", StringComparison.OrdinalIgnoreCase)
            || nativeClass.Equals("RichEdit20A", StringComparison.OrdinalIgnoreCase)
            || nativeClass.Equals("RICHEDIT50W", StringComparison.OrdinalIgnoreCase);
        if (!standardEdit && !richEdit) return null;
        long style = GetWindowLongPtr(gui.Focus, -16).ToInt64();
        // Protection evidence must survive a later unsupported/failed capability
        // query. Never let a provider's writable answer override ES_PASSWORD or
        // ES_READONLY merely because EM_CANPASTE/EM_GETSEL cannot be observed.
        if ((style & (0x20 | 0x800)) != 0) throw new CommandFailure("PROTECTED_TARGET");
        if ((style & 0x08000000) != 0) throw new CommandFailure("PROTECTED_TARGET"); // WS_DISABLED
        if (richEdit && (SendMessageTimeout(gui.Focus, 0x0432, 13, 0, 0x22, 100, out nuint paste) == 0 || paste == 0))
            return null; // EM_CANPASTE(CF_UNICODETEXT), read-only capability query
        nint selection = Marshal.AllocHGlobal(8);
        try
        {
            Marshal.WriteInt32(selection, -1); Marshal.WriteInt32(selection, 4, -1);
            // EM_GETSEL is a system message with cross-process marshalling. No
            // application-private pointer messages are sent to another process.
            if (SendMessageTimeout(gui.Focus, 0x00B0, (nuint)selection, selection + 4, 0x22, 100, out _) == 0) return null;
            uint start = unchecked((uint)Marshal.ReadInt32(selection));
            uint end = unchecked((uint)Marshal.ReadInt32(selection, 4));
            if (start == uint.MaxValue || end == uint.MaxValue) return null;
            if (GetForegroundWindow() != foreground) return null;
            return new(gui.Focus, (style & 0x20) != 0, (style & 0x800) != 0, start, end);
        }
        finally { Marshal.FreeHGlobal(selection); }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct GuiThreadInfo
    { internal uint Size, Flags; internal nint Active, Focus, Capture, MenuOwner, MoveSize, Caret; internal int Left, Top, Right, Bottom; }

    private sealed class DesktopHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        internal DesktopHandle(nint value) : base(true) => SetHandle(value);
        protected override bool ReleaseHandle() => CloseDesktop(handle);
    }

    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool PostMessage(nint window, uint message, nuint wParam, nint lParam);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool RegisterHotKey(nint window, int id, uint modifiers, uint key);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool UnregisterHotKey(nint window, int id);
    [DllImport("user32.dll", SetLastError = true)]
    internal static extern nint SetWindowsHookEx(int hook, KeyboardCallback callback, nint module, uint threadId);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    internal static extern bool UnhookWindowsHookEx(nint hook);
    [DllImport("user32.dll")]
    internal static extern nint CallNextHookEx(nint hook, int code, nint message, nint data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    internal static extern nint GetModuleHandle(string? module);
    [DllImport("user32.dll")]
    internal static extern nint GetForegroundWindow();
    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(nint window, out uint pid);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, [In] Input[] inputs, int size);
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo information);
    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(nint window, StringBuilder name, int maximum);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    private static extern nint GetWindowLongPtr(nint window, int index);
    [DllImport("user32.dll", EntryPoint = "SendMessageTimeoutW")]
    private static extern nint SendMessageTimeout(nint window, uint message, nuint wParam, nint lParam, uint flags, uint timeout, out nuint result);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeFileHandle CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32First(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32Next(SafeFileHandle snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern SafeProcessHandle OpenProcess(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(SafeProcessHandle process, out FileTime created, out FileTime exit, out FileTime kernel, out FileTime user);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenProcessToken(SafeProcessHandle process, uint access, out SafeAccessTokenHandle token);
    [DllImport("advapi32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetTokenInformation(SafeAccessTokenHandle token, int type, nint buffer, int length, out int required);
    [DllImport("advapi32.dll")]
    private static extern nint GetSidSubAuthorityCount(nint sid);
    [DllImport("advapi32.dll")]
    private static extern nint GetSidSubAuthority(nint sid, uint index);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern nint OpenInputDesktop(uint flags, [MarshalAs(UnmanagedType.Bool)] bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseDesktop(nint desktop);
    [DllImport("user32.dll", EntryPoint = "GetUserObjectInformationW", CharSet = CharSet.Unicode, SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetUserObjectInformation(DesktopHandle desktop, int index, StringBuilder name, uint length, out uint required);
}

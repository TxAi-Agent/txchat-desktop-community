using System.Runtime.InteropServices;

// Windows adaptation: follow the foreground keyboard window, not the pointer.
// Only physical monitor geometry crosses the private pipe; never window metadata.
internal static class HudDisplay
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { internal int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo { internal uint Size; internal Rect Monitor, Work; internal uint Flags; }
    [DllImport("user32.dll")]
    private static extern nint SetThreadDpiAwarenessContext(nint context);
    [DllImport("user32.dll")]
    private static extern nint MonitorFromWindow(nint window, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetMonitorInfoW", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetMonitorInfo(nint monitor, ref MonitorInfo info);

    internal static object Read()
    {
        object? bounds = null;
        // Scope this query only, preserving the UIA/WinForms thread's DPI context.
        nint previous = SetThreadDpiAwarenessContext(new nint(-4)); // PER_MONITOR_AWARE_V2
        if (previous == 0) return new { bounds };
        try
        {
            nint foreground = Win32.GetForegroundWindow();
            if (foreground == 0 || !Win32.DefaultDesktop()) return new { bounds };
            nint monitor = MonitorFromWindow(foreground, 0); // No arbitrary primary-screen fallback.
            var info = new MonitorInfo { Size = (uint)Marshal.SizeOf<MonitorInfo>() };
            if (monitor == 0 || !GetMonitorInfo(monitor, ref info)) return new { bounds };
            // A keyboard-window change during the query leaves the previous placement intact.
            if (Win32.GetForegroundWindow() != foreground) return new { bounds };
            long width = (long)info.Monitor.Right - info.Monitor.Left;
            long height = (long)info.Monitor.Bottom - info.Monitor.Top;
            if (width is <= 0 or > 1_000_000 || height is <= 0 or > 1_000_000
                || Math.Abs((long)info.Monitor.Left) > 1_000_000 || Math.Abs((long)info.Monitor.Top) > 1_000_000) return new { bounds };
            bounds = new { x = info.Monitor.Left, y = info.Monitor.Top, width, height };
            return new { bounds };
        }
        finally { SetThreadDpiAwarenessContext(previous); }
    }
}

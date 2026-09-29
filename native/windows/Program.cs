using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Application = System.Windows.Forms.Application;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        try
        {
            Application.SetUnhandledExceptionMode(UnhandledExceptionMode.ThrowException);
            // NativeWindow alone does not install a WinForms synchronization
            // context. Async WinRT creation must resume on this STA dispatcher.
            SynchronizationContext.SetSynchronizationContext(new WindowsFormsSynchronizationContext());
            using var output = new FrameWriter(Console.OpenStandardOutput());
            using var context = new HostContext(output);
            context.StartReader();
            Application.Run(context);
            return context.ExitCode;
        }
        catch (Exception exception)
        {
            Report(exception is HostFailure failure ? failure.Code : "IO_FAILURE");
            return 1;
        }
    }

    internal static void Report(string code)
    {
        // Never expose paths, request content, UI text, or exception messages.
        try { Console.Error.WriteLine(code); } catch { }
    }
}

internal sealed class HostContext : ApplicationContext
{
    private readonly MessageWindow window;
    private readonly FrameWriter writer;
    private readonly InputService input;
    private readonly AudioService audio = new();
    private readonly string instanceId = Guid.NewGuid().ToString();
    private volatile bool stopping;
    internal int ExitCode { get; private set; }

    internal HostContext(FrameWriter writer)
    {
        this.writer = writer;
        window = new MessageWindow();
        input = new InputService(window, writer, instanceId);
        Console.CancelKeyPress += CancelKeyPress;
        AppDomain.CurrentDomain.ProcessExit += ProcessExit;
    }

    internal void StartReader() => new Thread(ReadRequests)
    {
        IsBackground = true,
        Name = "TxChat Community protocol reader",
    }.Start();

    private void ReadRequests()
    {
        try
        {
            using var stream = Console.OpenStandardInput();
            while (Protocol.ReadRequest(stream) is { } request)
            {
                var completed = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
                // Only one request is pending. No unbounded GUI dispatcher queue.
                window.Post(async () =>
                {
                    bool shutdown = true;
                    try { shutdown = await DispatchAsync(request); }
                    catch (Exception exception) { await StopAsync(exception is HostFailure failure ? failure.Code : "IO_FAILURE"); }
                    finally { completed.TrySetResult(shutdown); }
                });
                while (!completed.Task.Wait(50))
                {
                    // Peek never consumes another request. Detect parent EOF
                    // during a suspended creation instead of waiting for it.
                    if (ParentPipeClosed()) { RequestStop(null); return; }
                    if (stopping) return;
                }
                if (completed.Task.GetAwaiter().GetResult() || stopping) return;
            }
            RequestStop(null);
        }
        catch (Exception exception)
        {
            string code = exception is HostFailure failure ? failure.Code : "IO_FAILURE";
            try { RequestStop(code); } catch { audio.Dispose(); Program.Report(code); }
        }
    }

    private async Task<bool> DispatchAsync(Request request)
    {
        if (stopping) return true;
        if (request.Version != 1)
        {
            writer.Error(request.Id, "PROTOCOL_MISMATCH");
            return false;
        }
        try
        {
            object result = request.Method switch
            {
                "hello" => new
                {
                    protocolVersion = 1, helperVersion = "0.1.0", instanceId, platform = "win32",
                    arch = RuntimeInformation.ProcessArchitecture switch
                    {
                        Architecture.X64 => "x64", Architecture.Arm64 => "arm64",
                        _ => throw new HostFailure("UNSUPPORTED_ARCHITECTURE"),
                    },
                    capabilities = new { handshake = true, hotkey = true, audio = true, insertion = true },
                },
                "ping" => new { alive = true },
                "hudDisplay" => HudDisplay.Read(),
                "shutdown" => new { stopping = true },
                "status" or "requestPermissions" or "requestAccessibility" => input.Status(),
                "configure" => input.Configure(Protocol.Configuration(request)),
                "captureTarget" => input.Capture(),
                "releaseTarget" => input.Release(Protocol.TargetId(request)),
                "insertText" => await input.InsertAsync(Protocol.Insertion(request)),
                "audioStatus" => audio.Status(),
                "requestAudioPermission" => await audio.PermissionAsync(),
                "preflightAudio" => audio.Preflight(Protocol.StreamId(request)),
                "startAudio" => await audio.StartAsync(Protocol.StreamId(request)),
                "stopAudio" => await audio.StopAsync(Protocol.StreamId(request), cancel: false),
                "cancelAudio" => await audio.StopAsync(Protocol.StreamId(request), cancel: true),
                "readAudio" => audio.Read(Protocol.StreamId(request), writer),
                _ => throw new CommandFailure("UNSUPPORTED_METHOD"),
            };
            if (request.Method == "shutdown")
            {
                input.Disable();
                await audio.ShutdownAsync();
            }
            if (stopping) return true;
            writer.Result(request.Id, result);
        }
        catch (CommandFailure failure) { if (!stopping) writer.Error(request.Id, failure.Code); }
        if (request.Method != "shutdown") return false;
        await StopAsync(null);
        return true;
    }

    private async Task StopAsync(string? failure)
    {
        if (stopping) return;
        stopping = true;
        // Invalidate pending insertion confirmation synchronously. Audio drivers
        // can take time to stop and must not prolong the input authorization.
        input.Disable();
        await input.ShutdownAsync();
        await audio.ShutdownAsync();
        input.Dispose();
        if (failure is not null) { ExitCode = 1; Program.Report(failure); }
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            Console.CancelKeyPress -= CancelKeyPress;
            AppDomain.CurrentDomain.ProcessExit -= ProcessExit;
            audio.Dispose();
            input.Dispose();
            window.Dispose();
        }
        base.Dispose(disposing);
    }

    private void RequestStop(string? failure)
    {
        // Cancellation and device shutdown begin without needing the STA. This
        // also covers stdout backpressure while the parent closes stdin.
        _ = audio.ShutdownAsync();
        window.Post(async () => await StopAsync(failure));
    }

    private void CancelKeyPress(object? sender, ConsoleCancelEventArgs args)
    {
        args.Cancel = true;
        try { RequestStop(null); } catch { audio.Dispose(); }
    }

    private void ProcessExit(object? sender, EventArgs args) => audio.Dispose();

    private static bool ParentPipeClosed()
    {
        nint handle = GetStdHandle(-10);
        if (handle == 0 || handle == -1 || GetFileType(handle) != 3) return false;
        return !PeekNamedPipe(handle, 0, 0, 0, out _, 0) && Marshal.GetLastWin32Error() is 109 or 232;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint GetStdHandle(int standardHandle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint GetFileType(nint handle);
    [DllImport("kernel32.dll", SetLastError = true)] [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool PeekNamedPipe(nint pipe, nint buffer, uint size, nint read, out uint available, nint left);
}

internal sealed class MessageWindow : NativeWindow, IDisposable
{
    private const int WorkMessage = 0x8001;
    private readonly ConcurrentQueue<Action> work = new();
    internal MessageWindow() => CreateHandle(new CreateParams
    {
        Caption = "TxChat Community input dispatcher", Parent = new nint(-3),
    });

    internal void Post(Action action)
    {
        work.Enqueue(action);
        if (!Win32.PostMessage(Handle, WorkMessage, 0, 0)) throw new HostFailure("IO_FAILURE");
    }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WorkMessage)
        {
            if (work.TryDequeue(out var action)) action();
            return;
        }
        // Registration reserves the shortcut. Physical phases come solely
        // from the filtered hook, so injected WM_HOTKEY cannot start a session.
        if (message.Msg == 0x0312) return;
        base.WndProc(ref message);
    }

    public void Dispose() => DestroyHandle();
}

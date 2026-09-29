using System.Runtime.InteropServices;
using System.Security.Cryptography;
using WinRT;
using Windows.Devices.Enumeration;
using Windows.Foundation;
using Windows.Media;
using Windows.Media.Audio;
using Windows.Media.Capture;
using Windows.Media.Devices;
using Windows.Media.MediaProperties;
using Windows.Media.Render;

// WinRT graph objects are agile. Recording creation resumes on the STA;
// permission checks and device shutdown need not retain the STA during exit.
// All managed stream state belongs to gate. No callback writes or logs PCM.
internal sealed class AudioService : IDisposable
{
    private const int QueueFrames = 20, StartDeadlineMilliseconds = 2200;
    private readonly object gate = new();
    private readonly CancellationTokenSource lifetime = new();
    private Session? current;
    private Session? permissionProbe;
    private int lastAttemptedId, pendingCreations;
    private int preparedId, cancelledPreparedId;
    private string? preparedInputDeviceId;
    private bool disposed, cleanupUncertain;
    private string? permissionDenial, permissionFailure;
    private bool permissionVerified;
    private long permissionDenialRevision;

    internal object Status()
    {
        lock (gate) return StatusLocked();
    }

    private object StatusLocked()
    {
        DeviceAccessStatus access = ObserveAccessLocked();
        return new
        {
            permission = permissionDenial ?? (permissionVerified || access == DeviceAccessStatus.Allowed ? "granted" : "systemManaged"),
            active = permissionProbe is not null || cleanupUncertain || pendingCreations != 0 || current is { Starting: true } || current is { State: "recording" }
                || current is { CloseTask.IsCompleted: false },
            // Recovery changes current permission, not the terminal result of
            // the old stream. Its read response retains the original failure.
            reason = permissionDenial is not null ? "AUDIO_PERMISSION_REQUIRED" : permissionFailure
                ?? (permissionVerified && current?.Reason == "AUDIO_PERMISSION_REQUIRED" ? null : current?.Reason),
        };
    }

    private DeviceAccessStatus ObserveAccessLocked()
    {
        DeviceAccessStatus access;
        try { access = DeviceAccessInformation.CreateFromDeviceClass(DeviceClass.AudioCapture).CurrentStatus; }
        catch { return DeviceAccessStatus.Unspecified; }
        if (access == DeviceAccessStatus.DeniedBySystem) DenyPermissionLocked("restricted");
        else if (access == DeviceAccessStatus.DeniedByUser) DenyPermissionLocked("denied");
        // Allowed is not enough to erase a real device-open denial. Unspecified
        // and query errors similarly retain the evidence already observed.
        return access;
    }

    private void DenyPermissionLocked(string? permission = null)
    {
        permissionDenial = permission ?? permissionDenial ?? "denied";
        permissionVerified = false;
        permissionDenialRevision++;
    }

    private void RequirePermissionLocked()
    {
        ObserveAccessLocked();
        if (permissionDenial is not null) throw new CommandFailure("AUDIO_PERMISSION_REQUIRED");
    }

    private static bool IsAccessDenied(Exception exception) => exception is UnauthorizedAccessException
        || exception is COMException { HResult: unchecked((int)0x80070005) }
        || exception is CommandFailure { Code: "AUDIO_PERMISSION_REQUIRED" };

    internal async Task<object> PermissionAsync()
    {
        Session probe;
        long verifiedAtRevision;
        lock (gate)
        {
            if (disposed) throw new CommandFailure("AUDIO_INVALID_STATE");
            if (IsBusyLocked() || preparedId != 0) throw new CommandFailure("AUDIO_BUSY");
            if (ObserveAccessLocked() is DeviceAccessStatus.DeniedByUser or DeviceAccessStatus.DeniedBySystem)
                return StatusLocked();
            string deviceId;
            try { deviceId = MediaDevice.GetDefaultAudioCaptureId(AudioDeviceRole.Default); }
            catch { deviceId = ""; }
            if (string.IsNullOrEmpty(deviceId))
            {
                permissionFailure = "AUDIO_DEVICE_UNAVAILABLE";
                return StatusLocked();
            }
            // This separate owner never enters the recording state, owns no
            // converter/output/tap, and never consumes a dictation stream ID.
            probe = new Session(0, deviceId) { State = "permission-probe" };
            permissionProbe = probe;
            verifiedAtRevision = permissionDenialRevision;
        }

        AudioGraph? graph = null;
        AudioDeviceInputNode? input = null;
        bool demonstrated = false;
        string? failure = null;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        timeout.CancelAfter(StartDeadlineMilliseconds);
        try
        {
            var device = await AwaitCreation(DeviceInformation.CreateFromIdAsync(probe.InputDeviceId), timeout.Token, _ => { }).ConfigureAwait(false);
            lock (gate) CheckPermissionProbeLocked(probe);
            if (device is null || !SameDevice(device.Id, probe.InputDeviceId)) throw new CommandFailure("AUDIO_DEVICE_UNAVAILABLE");
            timeout.Token.ThrowIfCancellationRequested();
            var result = await AwaitCreation(AudioGraph.CreateAsync(new AudioGraphSettings(AudioRenderCategory.Speech)), timeout.Token,
                late => late.Graph?.Dispose()).ConfigureAwait(false);
            graph = result.Graph;
            if (result.Status != AudioGraphCreationStatus.Success) throw new CommandFailure(MapGraphFailure(result.Status));
            if (graph is null) throw new CommandFailure("AUDIO_DEVICE_UNAVAILABLE");
            var encoding = graph.EncodingProperties;
            ValidateEncoding(encoding);
            AudioGraph ownedGraph = graph;
            lock (gate)
            {
                CheckPermissionProbeLocked(probe);
                probe.Graph = graph; graph = null;
            }
            timeout.Token.ThrowIfCancellationRequested();
            var opened = await AwaitCreation(ownedGraph.CreateDeviceInputNodeAsync(MediaCategory.Speech, encoding, device), timeout.Token,
                late => {
                    if (late.Status == AudioDeviceNodeCreationStatus.AccessDenied)
                        lock (gate) { if (!disposed) DenyPermissionLocked(); }
                    late.DeviceInputNode?.Dispose();
                }).ConfigureAwait(false);
            input = opened.DeviceInputNode;
            if (opened.Status != AudioDeviceNodeCreationStatus.Success) throw new CommandFailure(MapInputFailure(opened.Status));
            if (input is null) throw new CommandFailure("AUDIO_DEVICE_UNAVAILABLE");
            if (!SameDevice(input.Device.Id, probe.InputDeviceId)) throw new CommandFailure("INPUT_DEVICE_CHANGED");
            timeout.Token.ThrowIfCancellationRequested();
            lock (gate)
            {
                CheckPermissionProbeLocked(probe);
                probe.Input = input; input = null;
                demonstrated = true;
            }
            // Deliberately no Graph.Start, output node, callback or PCM access.
        }
        catch (Exception exception)
        {
            failure = IsAccessDenied(exception) ? "AUDIO_PERMISSION_REQUIRED"
                : exception is CommandFailure command ? command.Code
                : lifetime.IsCancellationRequested ? "AUDIO_INTERRUPTED" : "AUDIO_DEVICE_UNAVAILABLE";
            lock (gate) if (IsAccessDenied(exception)) DenyPermissionLocked();
        }
        finally
        {
            Task<bool> cleanup;
            lock (gate)
            {
                cleanup = CompletePermissionCleanup(probe, input, graph);
                probe.PermissionCleanupTask = cleanup;
            }
            try
            {
                if (!await cleanup.WaitAsync(timeout.Token).ConfigureAwait(false)) { demonstrated = false; failure ??= "AUDIO_INTERRUPTED"; }
            }
            catch (OperationCanceledException)
            {
                demonstrated = false;
                failure ??= lifetime.IsCancellationRequested ? "AUDIO_INTERRUPTED" : "AUDIO_DEVICE_UNAVAILABLE";
            }
            lock (gate)
            {
                if (demonstrated)
                {
                    try
                    {
                        timeout.Token.ThrowIfCancellationRequested();
                        CheckPermissionProbeLocked(probe);
                        if (cleanupUncertain || permissionDenialRevision != verifiedAtRevision)
                            throw new CommandFailure(permissionDenial is not null ? "AUDIO_PERMISSION_REQUIRED" : "AUDIO_INTERRUPTED");
                        permissionDenial = null; permissionFailure = null; permissionVerified = true;
                    }
                    catch (Exception exception)
                    {
                        demonstrated = false;
                        failure = exception is CommandFailure command ? command.Code
                            : lifetime.IsCancellationRequested ? "AUDIO_INTERRUPTED" : "AUDIO_DEVICE_UNAVAILABLE";
                    }
                }
                if (!demonstrated) permissionFailure = failure ?? "AUDIO_INTERRUPTED";
                probe.PermissionOperationDone = true;
                if (probe.PermissionCleanupFinished && permissionProbe == probe) permissionProbe = null;
            }
        }
        lock (gate) return StatusLocked();
    }

    private void CheckPermissionProbeLocked(Session probe)
    {
        if (disposed || permissionProbe != probe || probe.State != "permission-probe") throw new CommandFailure("AUDIO_INTERRUPTED");
        if (ObserveAccessLocked() is DeviceAccessStatus.DeniedByUser or DeviceAccessStatus.DeniedBySystem)
            throw new CommandFailure("AUDIO_PERMISSION_REQUIRED");
        if (!SameDevice(MediaDevice.GetDefaultAudioCaptureId(AudioDeviceRole.Default), probe.InputDeviceId))
            throw new CommandFailure("INPUT_DEVICE_CHANGED");
    }

    private async Task<bool> CompletePermissionCleanup(Session probe, AudioDeviceInputNode? input, AudioGraph? graph)
    {
        Task close = BeginCloseLocked(probe);
        Task<bool> local = Task.Run(() =>
        {
            lock (probe.NativeGate) return DisposeResources(null, null, input, graph);
        });
        bool clean;
        try { await Task.WhenAll(close, local).ConfigureAwait(false); clean = local.Result; }
        catch { clean = false; }
        lock (gate)
        {
            if (!clean) cleanupUncertain = true;
            probe.Starting = false;
            probe.PermissionCleanupFinished = true;
            if (probe.PermissionOperationDone && permissionProbe == probe) permissionProbe = null;
            return clean && !cleanupUncertain;
        }
    }

    internal object Preflight(int streamId)
    {
        lock (gate)
        {
            if (disposed || streamId <= lastAttemptedId) throw new CommandFailure("AUDIO_INVALID_STATE");
            // Every preparation attempt consumes its ID, even when busy or no
            // input exists. A later preparation also revokes the older snapshot.
            lastAttemptedId = streamId;
            ClearPreparedLocked();
            cancelledPreparedId = 0;
            if (IsBusyLocked()) throw new CommandFailure("AUDIO_BUSY");
            RequirePermissionLocked();
            string deviceId;
            try { deviceId = MediaDevice.GetDefaultAudioCaptureId(AudioDeviceRole.Default); }
            catch { throw new CommandFailure("AUDIO_DEVICE_UNAVAILABLE"); }
            if (string.IsNullOrEmpty(deviceId)) throw new CommandFailure("AUDIO_DEVICE_UNAVAILABLE");
            preparedId = streamId;
            preparedInputDeviceId = deviceId;
            return new { streamId, prepared = true };
        }
    }

    private bool IsBusyLocked() => permissionProbe is not null || cleanupUncertain || pendingCreations != 0 || current is { Starting: true }
        || current is { State: "recording" or "draining" } || current is { CloseTask.IsCompleted: false };

    private void ClearPreparedLocked() { preparedId = 0; preparedInputDeviceId = null; }

    internal async Task<object> StartAsync(int streamId)
    {
        Session session;
        lock (gate)
        {
            if (disposed || preparedId != streamId || preparedInputDeviceId is not { } deviceId)
                throw new CommandFailure("AUDIO_INVALID_STATE");
            ClearPreparedLocked();
            if (IsBusyLocked()) throw new CommandFailure("AUDIO_BUSY");
            current?.Converter?.Dispose();
            current?.Deadline?.Dispose();
            session = new Session(streamId, deviceId);
            current = session;
        }

        AudioGraph? graph = null;
        AudioDeviceInputNode? input = null;
        AudioFrameOutputNode? output = null;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        timeout.CancelAfter(StartDeadlineMilliseconds);
        try
        {
            WatchDefaultInput(session);
            timeout.Token.ThrowIfCancellationRequested();
            string deviceId = session.InputDeviceId;
            // Resolve only the captured device, never whichever default happens
            // to be selected when the asynchronous input creation completes.
            var device = await AwaitCreation(DeviceInformation.CreateFromIdAsync(deviceId), timeout.Token, _ => { });
            lock (gate)
            {
                CheckDefaultInputLocked(session);
                if (device is null || !SameDevice(device.Id, deviceId))
                    throw new CommandFailure("AUDIO_DEVICE_UNAVAILABLE");
            }
            timeout.Token.ThrowIfCancellationRequested();
            var settings = new AudioGraphSettings(AudioRenderCategory.Speech);
            var graphResult = await AwaitCreation(AudioGraph.CreateAsync(settings), timeout.Token,
                result => result.Graph?.Dispose());
            if (graphResult.Status != AudioGraphCreationStatus.Success)
                throw new CommandFailure(MapGraphFailure(graphResult.Status));
            graph = graphResult.Graph;
            var encoding = graph.EncodingProperties;
            ValidateEncoding(encoding);
            int sampleRate = checked((int)encoding.SampleRate), channels = checked((int)encoding.ChannelCount);
            AudioGraph ownedGraph = graph;
            lock (gate)
            {
                CheckDefaultInputLocked(session);
                // Make even the partially initialized graph reachable by EOF
                // cleanup while device-input creation is suspended.
                session.Graph = graph;
                graph = null;
            }
            timeout.Token.ThrowIfCancellationRequested();
            var inputResult = await AwaitCreation(ownedGraph.CreateDeviceInputNodeAsync(MediaCategory.Speech, encoding, device),
                timeout.Token, result => {
                    if (result.Status == AudioDeviceNodeCreationStatus.AccessDenied)
                        lock (gate) { if (!disposed) DenyPermissionLocked(); }
                    result.DeviceInputNode?.Dispose();
                });
            input = inputResult.DeviceInputNode;
            lock (gate)
            {
                // Preserve a real access refusal even if an earlier device
                // event has already made this stream terminal.
                if (inputResult.Status == AudioDeviceNodeCreationStatus.AccessDenied) DenyPermissionLocked();
                CheckDefaultInputLocked(session);
            }
            if (inputResult.Status != AudioDeviceNodeCreationStatus.Success)
                throw new CommandFailure(MapInputFailure(inputResult.Status));
            if (input is null) throw new CommandFailure("AUDIO_DEVICE_UNAVAILABLE");
            if (!SameDevice(input.Device.Id, deviceId)) throw new CommandFailure("INPUT_DEVICE_CHANGED");
            output = ownedGraph.CreateFrameOutputNode(encoding);
            input.AddOutgoingConnection(output);
            timeout.Token.ThrowIfCancellationRequested();

            lock (gate)
            {
                CheckDefaultInputLocked(session);
                session.SampleRate = sampleRate;
                session.Channels = channels;
                session.Converter = new Pcm16Converter(sampleRate, channels, bytes => EnqueueLocked(session, bytes));
                session.Input = input;
                session.Output = output;
                input = null; output = null;
                session.Quantum = (sender, _) => OnQuantum(session, sender);
                session.Error = (_, _) => OnGraphError(session);
                ownedGraph.QuantumStarted += session.Quantum;
                ownedGraph.UnrecoverableErrorOccurred += session.Error;
                session.State = "recording";
                session.Starting = false;
                // Ownership transfers before Start: a synchronous native error
                // can safely schedule shutdown without orphaning resources.
            }
            lock (session.NativeGate)
            {
                lock (gate)
                {
                    if (disposed || session.State != "recording" || session.Graph != ownedGraph)
                        throw new CommandFailure(session.Reason ?? "AUDIO_INTERRUPTED");
                    CheckDefaultInputLocked(session);
                }
                // Serialize Start against native Stop/Dispose without holding
                // gate: synchronous callbacks must be able to enter gate.
                ownedGraph.Start();
            }
            lock (gate)
            {
                CheckDefaultInputLocked(session);
                permissionVerified = true;
                permissionFailure = null;
                // Independent of readAudio and the STA/stdout pipe. The sample
                // cap is enforced separately inside the converter.
                session.Deadline = new System.Threading.Timer(_ => Limit(session), null,
                    TimeSpan.FromSeconds(300), Timeout.InfiniteTimeSpan);
            }
            return new { streamId, sampleRate = 16000, channels = 1, encoding = "pcm_s16le" };
        }
        catch (Exception exception)
        {
            string reason = IsAccessDenied(exception) ? "AUDIO_PERMISSION_REQUIRED" : exception switch
            {
                CommandFailure failure => failure.Code,
                OperationCanceledException when lifetime.IsCancellationRequested => "AUDIO_INTERRUPTED",
                _ => "AUDIO_DEVICE_UNAVAILABLE",
            };
            lock (gate)
            {
                if (IsAccessDenied(exception)) DenyPermissionLocked();
                // Creation can fault before Windows delivers its default-device
                // event. Prefer a confirmed identity change over the generic
                // creation error, while preserving a failure that already won.
                if (!disposed && current == session && session.State == "recording")
                {
                    try { CheckDefaultInputLocked(session); }
                    catch (CommandFailure failure) when (failure.Code == "INPUT_DEVICE_CHANGED") { reason = failure.Code; }
                    catch { /* Retain the sanitized original creation failure. */ }
                }
                FailLocked(session, reason);
                // A device notification can win while an asynchronous creation
                // faults. Preserve that first failure in both status and reply.
                reason = session.Reason ?? reason;
            }
            throw new CommandFailure(reason);
        }
        finally
        {
            // A late asynchronous creation has its own cleanup continuation.
            // Never wait for an unknown-length WinRT operation during shutdown.
            bool clean = DisposeResources(null, output, input, graph);
            lock (gate)
            {
                if (!clean) cleanupUncertain = true;
                session.Starting = false;
            }
        }
    }

    private static bool SameDevice(string? first, string? second) =>
        !string.IsNullOrEmpty(first) && string.Equals(first, second, StringComparison.OrdinalIgnoreCase);

    private void WatchDefaultInput(Session session)
    {
        // Registration and revocation serialize with native close. Publish the
        // handler before registering it so partial registration is reclaimable.
        lock (session.NativeGate)
        {
            TypedEventHandler<object, DefaultAudioCaptureDeviceChangedEventArgs> handler;
            lock (gate)
            {
                if (disposed || current != session || session.State != "recording")
                    throw new CommandFailure(session.Reason ?? "AUDIO_INTERRUPTED");
                // The snapshot predates the service connection. Never replace
                // it with the default observed after that asynchronous wait.
                CheckDefaultInputLocked(session);
                handler = (_, change) => OnDefaultInputChanged(session, change);
                session.DefaultInputChanged = handler;
            }
            MediaDevice.DefaultAudioCaptureDeviceChanged += handler;
            lock (gate) CheckDefaultInputLocked(session);
        }
    }

    private void CheckDefaultInputLocked(Session session)
    {
        if (disposed || current != session || session.State != "recording")
            throw new CommandFailure(session.Reason ?? "AUDIO_INTERRUPTED");
        RequirePermissionLocked();
        if (!SameDevice(MediaDevice.GetDefaultAudioCaptureId(AudioDeviceRole.Default), session.InputDeviceId)
            || (session.Input is { } input && !SameDevice(input.Device.Id, session.InputDeviceId)))
            throw new CommandFailure("INPUT_DEVICE_CHANGED");
    }

    private bool CheckRecordingInputLocked(Session session)
    {
        try { CheckDefaultInputLocked(session); return true; }
        catch (CommandFailure failure) { FailLocked(session, failure.Code); }
        catch (Exception exception) { FailLocked(session, IsAccessDenied(exception) ? "AUDIO_PERMISSION_REQUIRED" : "AUDIO_INTERRUPTED"); }
        return false;
    }

    private void OnDefaultInputChanged(Session session, DefaultAudioCaptureDeviceChangedEventArgs change)
    {
        lock (gate)
        {
            if (disposed || current != session || session.State != "recording" || session.DefaultInputChanged is null) return;
            try
            {
                // Use the event's ID as well as read-time checks: an A -> B -> A
                // change must still end this stream even if B was short-lived.
                if (change.Role == AudioDeviceRole.Default && !SameDevice(change.Id, session.InputDeviceId))
                    FailLocked(session, "INPUT_DEVICE_CHANGED");
            }
            catch { FailLocked(session, "AUDIO_INTERRUPTED"); }
        }
    }

    private void OnGraphError(Session session)
    {
        lock (gate)
        {
            if (disposed || current != session || session.State != "recording") return;
            if (CheckRecordingInputLocked(session)) FailLocked(session, "AUDIO_INTERRUPTED");
        }
    }

    private async Task<T> AwaitCreation<T>(IAsyncOperation<T> operation, CancellationToken cancellation, Action<T> disposeLate)
    {
        Task<T> task = operation.AsTask();
        lock (gate) pendingCreations++;
        bool deferred = false;
        // Late-creation reclamation must run even after the STA is exiting.
        // Callers retain their own synchronization context where required.
        try { return await task.WaitAsync(cancellation).ConfigureAwait(false); }
        catch (OperationCanceledException)
        {
            deferred = true;
            // Do not abandon a task that could still hand back a live device.
            // New streams stay busy until this exact task has been reclaimed.
            _ = ReclaimLateCreation(task, disposeLate);
            throw;
        }
        finally { if (!deferred) lock (gate) pendingCreations--; }
    }

    private async Task ReclaimLateCreation<T>(Task<T> task, Action<T> disposeLate)
    {
        try
        {
            T result = await task.ConfigureAwait(false);
            try { disposeLate(result); }
            catch { lock (gate) cleanupUncertain = true; }
        }
        catch (Exception exception)
        {
            // The timeout does not invalidate later negative permission evidence.
            // Successful late results are still cleanup-only and never grant access.
            if (IsAccessDenied(exception)) lock (gate) { if (!disposed) DenyPermissionLocked(); }
        }
        finally { lock (gate) pendingCreations--; }
    }

    internal async Task<object> StopAsync(int streamId, bool cancel)
    {
        Task close;
        lock (gate)
        {
            if (!disposed && cancel && (preparedId == streamId || cancelledPreparedId == streamId))
            {
                ClearPreparedLocked();
                cancelledPreparedId = streamId;
                return new { streamId, stopped = true };
            }
            Session session = RequireCurrent(streamId);
            if (cancel && (session.State is "recording" or "draining"))
                FailLocked(session, "AUDIO_CANCELLED");
            else if (session.State == "recording" && CheckRecordingInputLocked(session)) session.State = "draining";
            close = BeginCloseLocked(session);
        }
        await close;
        return new { streamId, stopped = true };
    }

    internal object Read(int streamId, FrameWriter writer)
    {
        var frames = new List<(uint Sequence, byte[] Bytes)>(4);
        Session session;
        string state;
        string? reason;
        int totalSamples;
        lock (gate)
        {
            session = RequireCurrent(streamId);
            if (session.State == "recording") CheckRecordingInputLocked(session);
            // Only an already empty queue can become ended here: the final
            // nonempty snapshot still reports draining, and the next read
            // confirms that its tail has actually finished transmission.
            if (session.State == "draining" && session.CloseTask is { IsCompleted: true }
                && session.Frames.Count == 0) session.State = "ended";
            state = session.State;
            reason = session.Reason;
            totalSamples = session.Converter?.TotalSamples ?? 0;
            if (state != "failed")
            {
                while (frames.Count < 4 && session.Frames.TryDequeue(out byte[]? bytes))
                    frames.Add((++session.Sequence, bytes));
                session.InFlightFrames += frames.Count;
            }
        }
        // Frames and metadata are one committed snapshot. Device failure may
        // now clear the producer queue and stop the graph, but cannot turn this
        // response into failed with nonzero frameCount. The next read publishes
        // failed/0. Never hold the capture gate during potentially blocked I/O.
        try
        {
            foreach (var frame in frames) writer.WriteAudio(streamId, frame.Sequence, frame.Bytes);
            return new
            {
                streamId, state, reason, frameCount = frames.Count, totalSamples,
            };
        }
        finally
        {
            // The bounded snapshot owns its buffers until transmission exits;
            // failure/EOF cannot zero a buffer while the pipe is reading it.
            // This clears all four even if the first WriteAudio throws.
            foreach (var frame in frames) CryptographicOperations.ZeroMemory(frame.Bytes);
            lock (gate) session.InFlightFrames -= frames.Count;
        }
    }

    private Session RequireCurrent(int streamId)
    {
        if (disposed || current is not { } session || session.Id != streamId || session.Starting)
            throw new CommandFailure("AUDIO_INVALID_STATE");
        return session;
    }

    private unsafe void OnQuantum(Session session, AudioGraph sender)
    {
        // Synchronous QuantumStarted/GetFrame is the AudioGraph-supported
        // cadence. The callback never waits for cleanup, stdout, or the network.
        lock (gate)
        {
            if (disposed || current != session || session.State != "recording" || session.Output is null) return;
            try
            {
                var encoding = sender.EncodingProperties;
                ValidateEncoding(encoding);
                if (encoding.SampleRate != session.SampleRate || encoding.ChannelCount != session.Channels)
                    throw new CommandFailure("AUDIO_FORMAT_UNSUPPORTED");
                using AudioFrame frame = session.Output.GetFrame();
                using AudioBuffer buffer = frame.LockBuffer(AudioBufferAccessMode.Read);
                // Bound the native callback before acquiring/copying its data.
                uint maximumBytes = checked((uint)(session.SampleRate / 10 * session.Channels * sizeof(float)));
                if (buffer.Length > maximumBytes || buffer.Length % (session.Channels * sizeof(float)) != 0)
                    throw new CommandFailure("AUDIO_FORMAT_UNSUPPORTED");
                using IMemoryBufferReference reference = buffer.CreateReference();
                reference.As<IMemoryBufferByteAccess>().GetBuffer(out byte* data, out uint capacity);
                if (buffer.Length > capacity || (data == null && buffer.Length != 0))
                    throw new CommandFailure("AUDIO_CONVERSION_FAILED");
                var samples = new ReadOnlySpan<float>(data, checked((int)buffer.Length / sizeof(float)));
                session.Converter!.Append(samples, session.SampleRate, session.Channels);
                if (session.Converter.LimitReached) LimitLocked(session);
            }
            catch (CommandFailure failure) { FailLocked(session, failure.Code); }
            catch (UnauthorizedAccessException) { FailLocked(session, "AUDIO_PERMISSION_REQUIRED"); }
            catch (COMException exception)
            {
                if (IsAccessDenied(exception)) FailLocked(session, "AUDIO_PERMISSION_REQUIRED");
                else if (CheckRecordingInputLocked(session)) FailLocked(session, "AUDIO_INTERRUPTED");
            }
            catch { FailLocked(session, "AUDIO_CONVERSION_FAILED"); }
        }
    }

    private void EnqueueLocked(Session session, ReadOnlySpan<byte> bytes)
    {
        if (session.Frames.Count + session.InFlightFrames >= QueueFrames)
            throw new CommandFailure("AUDIO_OVERFLOW");
        session.Frames.Enqueue(bytes.ToArray());
    }

    private void Limit(Session session) { lock (gate) LimitLocked(session); }
    private void LimitLocked(Session session)
    {
        if (disposed || current != session || session.State != "recording") return;
        if (!CheckRecordingInputLocked(session)) return;
        session.State = "draining";
        session.Reason = "AUDIO_LIMIT_REACHED";
        _ = BeginCloseLocked(session);
    }

    private void FailLocked(Session session, string reason)
    {
        if (reason == "AUDIO_PERMISSION_REQUIRED") DenyPermissionLocked();
        if (session.State != "failed")
        {
            session.State = "failed";
            session.Reason = reason;
        }
        ClearPcmLocked(session);
        _ = BeginCloseLocked(session);
    }

    private Task BeginCloseLocked(Session session) => session.CloseTask ??= Task.Run(() => CloseSession(session));

    private void CloseSession(Session session)
    {
        AudioGraph? graph;
        AudioDeviceInputNode? input;
        AudioFrameOutputNode? output;
        TypedEventHandler<object, DefaultAudioCaptureDeviceChangedEventArgs>? defaultInputChanged;
        lock (gate)
        {
            session.Deadline?.Dispose();
            session.Deadline = null;
            graph = session.Graph; input = session.Input; output = session.Output;
            session.Graph = null; session.Input = null; session.Output = null;
            defaultInputChanged = session.DefaultInputChanged;
            session.DefaultInputChanged = null;
        }
        bool clean;
        lock (session.NativeGate)
        {
            clean = true;
            try
            {
                if (defaultInputChanged is not null) MediaDevice.DefaultAudioCaptureDeviceChanged -= defaultInputChanged;
            }
            catch { clean = false; }
            if (!DisposeResources(session, output, input, graph)) clean = false;
        }
        lock (gate)
        {
            // A failed native close cannot prove device ownership ended.
            // Keep this instance unavailable until its parent restarts it.
            if (!clean) cleanupUncertain = true;
            if (!clean && session.State != "failed")
            {
                session.State = "failed";
                session.Reason = "AUDIO_INTERRUPTED";
                ClearPcmLocked(session);
            }
            if (session.State != "draining") return;
            try { session.Converter?.Finish(); }
            catch (CommandFailure failure) { FailLocked(session, failure.Code); }
            catch { FailLocked(session, "AUDIO_CONVERSION_FAILED"); }
        }
    }

    private static bool DisposeResources(Session? session, AudioFrameOutputNode? output, AudioDeviceInputNode? input, AudioGraph? graph)
    {
        bool clean = true;
        if (graph is not null)
        {
            try
            {
                if (session?.Quantum is { } quantum) graph.QuantumStarted -= quantum;
                if (session?.Error is { } error) graph.UnrecoverableErrorOccurred -= error;
            }
            catch { clean = false; }
            try { graph.Stop(); } catch { clean = false; }
        }
        try { output?.Dispose(); } catch { clean = false; }
        try { input?.Dispose(); } catch { clean = false; }
        try { graph?.Dispose(); } catch { clean = false; }
        return clean;
    }

    private static void ClearPcmLocked(Session session)
    {
        while (session.Frames.TryDequeue(out byte[]? bytes)) CryptographicOperations.ZeroMemory(bytes);
        session.Converter?.Dispose();
    }

    internal Task ShutdownAsync()
    {
        lifetime.Cancel();
        lock (gate)
        {
            disposed = true;
            ClearPreparedLocked();
            cancelledPreparedId = 0;
            Task streamClose = Task.CompletedTask, probeClose = Task.CompletedTask;
            if (current is { } session)
            {
                FailLocked(session, "AUDIO_INTERRUPTED");
                streamClose = BeginCloseLocked(session);
            }
            if (permissionProbe is { } probe)
            {
                probe.State = "failed";
                probe.Reason ??= "AUDIO_INTERRUPTED";
                probeClose = probe.PermissionCleanupTask ?? BeginCloseLocked(probe);
            }
            return Task.WhenAll(streamClose, probeClose);
        }
    }

    public void Dispose()
    {
        // Fallback for process/app-context disposal: close currently owned
        // objects without waiting for a pending WinRT creation's future.
        lifetime.Cancel();
        Session? session, probe;
        lock (gate)
        {
            disposed = true;
            ClearPreparedLocked();
            cancelledPreparedId = 0;
            session = current;
            probe = permissionProbe;
            if (session is not null)
            {
                session.State = "failed";
                session.Reason ??= "AUDIO_INTERRUPTED";
                ClearPcmLocked(session);
            }
            if (probe is not null)
            {
                probe.State = "failed";
                probe.Reason ??= "AUDIO_INTERRUPTED";
            }
        }
        if (session is not null) CloseSession(session);
        if (probe is not null) CloseSession(probe);
    }

    private static void ValidateEncoding(AudioEncodingProperties encoding)
    {
        if (encoding.BitsPerSample != 32 || encoding.Subtype != MediaEncodingSubtypes.Float
            || encoding.SampleRate is < 16000 or > 192000 || encoding.ChannelCount is < 1 or > 32)
            throw new CommandFailure("AUDIO_FORMAT_UNSUPPORTED");
    }

    private static string MapGraphFailure(AudioGraphCreationStatus status) => status switch
    {
        AudioGraphCreationStatus.FormatNotSupported => "AUDIO_FORMAT_UNSUPPORTED",
        _ => "AUDIO_DEVICE_UNAVAILABLE",
    };
    private static string MapInputFailure(AudioDeviceNodeCreationStatus status) => status switch
    {
        AudioDeviceNodeCreationStatus.AccessDenied => "AUDIO_PERMISSION_REQUIRED",
        AudioDeviceNodeCreationStatus.FormatNotSupported => "AUDIO_FORMAT_UNSUPPORTED",
        _ => "AUDIO_DEVICE_UNAVAILABLE",
    };

    private sealed class Session(int id, string inputDeviceId)
    {
        internal int Id { get; } = id;
        internal object NativeGate { get; } = new();
        internal string State = "recording";
        internal string? Reason;
        internal string InputDeviceId { get; } = inputDeviceId;
        internal bool Starting = true;
        internal int SampleRate, Channels, InFlightFrames;
        internal uint Sequence;
        internal Queue<byte[]> Frames { get; } = new(QueueFrames);
        internal Pcm16Converter? Converter;
        internal AudioGraph? Graph;
        internal AudioDeviceInputNode? Input;
        internal AudioFrameOutputNode? Output;
        internal TypedEventHandler<AudioGraph, object>? Quantum;
        internal TypedEventHandler<AudioGraph, AudioGraphUnrecoverableErrorOccurredEventArgs>? Error;
        internal TypedEventHandler<object, DefaultAudioCaptureDeviceChangedEventArgs>? DefaultInputChanged;
        internal System.Threading.Timer? Deadline;
        internal Task? CloseTask;
        internal Task<bool>? PermissionCleanupTask;
        internal bool PermissionOperationDone, PermissionCleanupFinished;
    }
}

[ComImport]
[Guid("5B0D3235-4DBA-4D44-865E-8F1D0E4FD04D")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal unsafe interface IMemoryBufferByteAccess
{
    void GetBuffer(out byte* buffer, out uint capacity);
}

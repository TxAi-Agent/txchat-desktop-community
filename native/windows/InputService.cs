using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Automation;
using System.Windows.Automation.Text;

internal sealed record CapturedTarget(string targetId, string applicationName);

// This object, UIA references, and all mutation state belong to the main STA.
internal sealed class InputService : IDisposable
{
    private const int MaximumTargets = 16, MaximumOperations = 1024, MaximumObservedText = 65536;
    private readonly MessageWindow window;
    private readonly FrameWriter writer;
    private readonly string instanceId;
    private readonly ClipboardTextPasteTransaction paste;
    private readonly Win32.KeyboardCallback keyboardCallback;
    private readonly Win32.KeyboardCallback mouseCallback;
    private readonly AutomationFocusChangedEventHandler focusChanged;
    private readonly AutomationEventHandler globalSelectionChanged;
    private readonly Dictionary<string, Target> targets = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Operation> operations = new(StringComparer.Ordinal);
    private readonly HashSet<int> ownPids = [];
    private readonly int parentPid;
    private readonly long parentCreated;
    private long focusEpoch;
    private long focusOnlyEpoch;
    private long interactionEpoch;
    private readonly object focusNoticeGate = new();
    private nint noticedWindow;
    private int[]? noticedRuntimeId;
    private readonly WindowsAutomationEvents automationEvents = new();
    private IDisposable? continuitySubscription;
    private HashSet<int> excludedPids = [];
    private nint hook;
    private nint mouseHook;
    private int registeredId;
    private int generation;
    private int hotkeyEpoch;
    private int pendingSignals;
    private long sequence;
    private bool enabled, physicalPressed, waitingForNeutral, disposed;
    // Retained across layout/VK replacement until this physical main key is released.
    private bool mainPhysicalDown;
    private string binding = "key::F8";
    private ShortcutBinding shortcut = ShortcutBinding.Parse("key::F8");
    private nint shortcutLayout;
    private bool shortcutNumLock, registrationSuspended, registrationRefreshPending;
    private ShortcutBinding? suspendedReservation;
    private nint suspendedLayout;
    private bool suspendedNumLock;
    private string? statusReason;

    internal InputService(MessageWindow window, FrameWriter writer, string instanceId)
    {
        this.window = window;
        this.writer = writer;
        this.instanceId = instanceId;
        paste = new ClipboardTextPasteTransaction(new NativeClipboardText(window.Handle));
        keyboardCallback = KeyboardHook;
        mouseCallback = MouseHook;
        focusChanged = (sender, _) =>
        {
            // A repeated notification for the same focus is not a transition.
            // Read identity only, never text/selection, on the UIA callback.
            int[]? runtime = null;
            try { runtime = (sender as AutomationElement)?.GetRuntimeId(); } catch { }
            nint foreground = Win32.GetForegroundWindow();
            lock (focusNoticeGate)
            {
                bool same = InputTargetPolicy.SameFocusNotice(noticedWindow, noticedRuntimeId, foreground, runtime);
                noticedWindow = foreground; noticedRuntimeId = runtime;
                if (same) return;
                Interlocked.Increment(ref focusOnlyEpoch);
                Interlocked.Increment(ref focusEpoch);
            }
        };
        globalSelectionChanged = (_, _) => Interlocked.Increment(ref focusEpoch);
        var parents = Win32.ProcessParents();
        if (!parents.TryGetValue(Environment.ProcessId, out parentPid) || parentPid <= 0)
            throw new HostFailure("IO_FAILURE");
        ownPids.UnionWith([Environment.ProcessId, parentPid]);
        parentCreated = Win32.CreationTime(parentPid);
    }

    internal object Status()
    {
        // Surface a stale reservation as suspended even before the next gesture.
        if (enabled && !registrationRefreshPending && !registrationSuspended)
        {
            nint layout = ShortcutBinding.CurrentLayout();
            bool numLock = ShortcutBinding.NumLockEnabled;
            if (ReservationEnvironmentChanged(layout, numLock))
                RequestReservationRefresh(shortcut.Resolve(layout), layout, numLock);
        }
        return new
        {
            accessibility = "notRequired", inputMonitoring = "notRequired",
            enabled = enabled && !registrationSuspended, binding, generation, reason = statusReason,
        };
    }

    internal object Configure(Configuration configuration)
    {
        // Validate the entire transition before touching the existing state.
        // Valid disable requests still clear all registration and target state.
        if (configuration.Generation <= generation) throw new CommandFailure("INVALID_ARGUMENTS");
        var parsed = ShortcutBinding.Parse(configuration.Binding);
        nint layout = ShortcutBinding.CurrentLayout();
        var nextShortcut = parsed.Resolve(layout);
        if (!configuration.Enabled)
        {
            Disable();
            generation = configuration.Generation;
            binding = configuration.Binding;
            shortcut = nextShortcut; shortcutLayout = layout; shortcutNumLock = ShortcutBinding.NumLockEnabled;
            excludedPids = configuration.ExcludedPids.ToHashSet();
            return Status();
        }
        if (enabled && registeredId != 0 && shortcut.Modifiers == nextShortcut.Modifiers && shortcut.VirtualKey == nextShortcut.VirtualKey)
        {
            CommitConfiguration(configuration, nextShortcut, layout);
            return Status();
        }
        int newId = registeredId == 0x5101 ? 0x5102 : 0x5101;
        uint modifiers = 0x4000u | nextShortcut.Modifiers;
        if (!Win32.RegisterHotKey(window.Handle, newId, modifiers, nextShortcut.VirtualKey))
        {
            string reason = Marshal.GetLastWin32Error() == 1409 ? "HOTKEY_CONFLICT" : "HOTKEY_UNAVAILABLE";
            statusReason = reason;
            throw new CommandFailure(reason);
        }
        // Prepare both native resources before releasing the old binding.
        nint newHook = hook;
        if (newHook == 0) newHook = Win32.SetWindowsHookEx(13, keyboardCallback, Win32.GetModuleHandle(null), 0);
        if (newHook == 0)
        {
            Win32.UnregisterHotKey(window.Handle, newId);
            statusReason = "HOTKEY_UNAVAILABLE";
            throw new CommandFailure("HOTKEY_UNAVAILABLE");
        }
        nint newMouseHook = mouseHook;
        if (newMouseHook == 0) newMouseHook = Win32.SetWindowsHookEx(14, mouseCallback, Win32.GetModuleHandle(null), 0);
        if (newMouseHook == 0)
        {
            Win32.UnregisterHotKey(window.Handle, newId);
            if (hook == 0) Win32.UnhookWindowsHookEx(newHook);
            statusReason = "HOTKEY_UNAVAILABLE";
            throw new CommandFailure("HOTKEY_UNAVAILABLE");
        }
        if (continuitySubscription is null)
        {
            try
            {
                SubscribeContinuity();
            }
            catch
            {
                Win32.UnregisterHotKey(window.Handle, newId);
                if (hook == 0) Win32.UnhookWindowsHookEx(newHook);
                if (mouseHook == 0) Win32.UnhookWindowsHookEx(newMouseHook);
                throw new CommandFailure("HOTKEY_UNAVAILABLE");
            }
        }
        if (registeredId != 0) Win32.UnregisterHotKey(window.Handle, registeredId);
        registeredId = newId;
        hook = newHook;
        mouseHook = newMouseHook;
        CommitConfiguration(configuration, nextShortcut, layout);
        return Status();
    }

    private void SubscribeContinuity()
    {
        continuitySubscription ??= automationEvents.SubscribeContinuity(focusChanged, globalSelectionChanged);
    }

    private void CommitConfiguration(Configuration configuration, ShortcutBinding nextShortcut, nint layout)
    {
        binding = configuration.Binding;
        shortcut = nextShortcut; shortcutLayout = layout; shortcutNumLock = ShortcutBinding.NumLockEnabled;
        generation = configuration.Generation;
        excludedPids = configuration.ExcludedPids.ToHashSet();
        enabled = true;
        registrationSuspended = false; registrationRefreshPending = false; suspendedReservation = null;
        statusReason = null;
        hotkeyEpoch++;
        physicalPressed = false;
        // Existing VK state is a temporary neutral barrier, not evidence of
        // this physical key: keypad/navigation keys may share a virtual key.
        mainPhysicalDown = false;
        waitingForNeutral = ChordKeysDown(0, false);
        ClearTargets();
    }

    internal void Disable()
    {
        paste.Cancel();
        enabled = false;
        registrationSuspended = false; registrationRefreshPending = false; suspendedReservation = null;
        hotkeyEpoch++;
        physicalPressed = false;
        mainPhysicalDown = false;
        waitingForNeutral = true;
        if (registeredId != 0) { Win32.UnregisterHotKey(window.Handle, registeredId); registeredId = 0; }
        if (hook != 0) { Win32.UnhookWindowsHookEx(hook); hook = 0; }
        if (mouseHook != 0) { Win32.UnhookWindowsHookEx(mouseHook); mouseHook = 0; }
        ClearTargets();
        // Keep process-lifetime continuity listeners while editing a shortcut.
        // Disabled input has no hooks/reservation or reusable target. Repeated
        // opening/cancelling the editor must not churn global UIA registrations.
        statusReason = null;
        // Results survive disable/reconfigure, preventing replay in this instance.
        // A cancelled paste keeps the recognition clipboard; it never restores old data.
    }

    private bool ReservationEnvironmentChanged(nint layout, bool numLock) =>
        (shortcut.IsLayoutSensitive && layout != shortcutLayout) || (shortcut.IsNumericKeypad && numLock != shortcutNumLock);

    private void RequestReservationRefresh(ShortcutBinding desired, nint layout, bool numLock)
    {
        if (!enabled || registrationRefreshPending) return;
        registrationSuspended = true; registrationRefreshPending = true;
        suspendedReservation = desired; suspendedLayout = layout; suspendedNumLock = numLock;
        physicalPressed = false; waitingForNeutral = true;
        statusReason = "HOTKEY_UNAVAILABLE";
        int epoch = ++hotkeyEpoch;
        // Native resource changes run after the low-level callback returns.
        window.Post(() =>
        {
            if (!enabled || epoch != hotkeyEpoch) return;
            registrationRefreshPending = false;
            if ((desired.IsLayoutSensitive && ShortcutBinding.CurrentLayout() != layout) ||
                (desired.IsNumericKeypad && ShortcutBinding.NumLockEnabled != numLock)) return;
            int replacementId = registeredId;
            if (registeredId == 0 || desired.VirtualKey != shortcut.VirtualKey || desired.Modifiers != shortcut.Modifiers)
            {
                replacementId = registeredId == 0x5101 ? 0x5102 : 0x5101;
                if (!Win32.RegisterHotKey(window.Handle, replacementId, 0x4000u | desired.Modifiers, desired.VirtualKey))
                {
                    // Keep the previous physical binding and reservation. It is
                    // suspended, not silently active under the wrong VK; a later
                    // gesture or returning to the old environment retries safely.
                    statusReason = Marshal.GetLastWin32Error() == 1409 ? "HOTKEY_CONFLICT" : "HOTKEY_UNAVAILABLE";
                    return;
                }
                if (registeredId != 0) Win32.UnregisterHotKey(window.Handle, registeredId);
            }
            registeredId = replacementId;
            shortcut = desired; shortcutLayout = layout; shortcutNumLock = numLock;
            statusReason = null; registrationSuspended = false; suspendedReservation = null;
            // The triggering gesture is always discarded. Only a fresh chord
            // after every involved key has returned neutral may emit an event.
            waitingForNeutral = ChordKeysDown(0, false);
        });
    }

    private nint MouseHook(int code, nint message, nint data)
    {
        // Only retain an epoch, never coordinates, buttons, or user content.
        if (code >= 0 && enabled)
        {
            try
            {
                if (InputTargetPolicy.InvalidatesPointer((int)message,
                    (Marshal.PtrToStructure<Win32.MouseHookData>(data).Flags & 1) == 0, Win32.MouseButtonsHeld()))
                    Interlocked.Increment(ref interactionEpoch);
            }
            catch { Interlocked.Increment(ref interactionEpoch); }
        }
        return Win32.CallNextHookEx(mouseHook, code, message, data);
    }

    private nint KeyboardHook(int code, nint message, nint data)
    {
        try
        {
            if (code >= 0 && enabled)
            {
                var key = Marshal.PtrToStructure<Win32.KeyboardHookData>(data);
                if (InputTargetPolicy.IsOwnInjection(key.Flags, key.ExtraInfo, Win32.PasteInputMarker))
                    return Win32.CallNextHookEx(hook, code, message, data);
                bool down = message == 0x0100 || message == 0x0104;
                bool up = message == 0x0101 || message == 0x0105;
                // Only selected chord keys are considered. Never record ordinary
                // keys, text, timestamps, or raw input, and ignore injected keys.
                int rawKey = (int)key.VirtualKey;
                int virtualKey = NormalizeKey(rawKey);
                bool mainKey = shortcut.Matches(key);
                if (InputTargetPolicy.InvalidatesKey(down, (key.Flags & 0x12) == 0,
                    mainKey && ChordModifiersDown(), shortcut.UsesModifier(virtualKey)))
                    Interlocked.Increment(ref interactionEpoch);
                if (mainKey && (key.Flags & 0x12) == 0 && (down || up)) mainPhysicalDown = down;
                // A physical key may acquire another VK after a layout/NumLock
                // change. Cancel this gesture and reserve the new VK first.
                if ((key.Flags & 0x12) == 0 && (down || up))
                {
                    nint layout = ShortcutBinding.CurrentLayout();
                    bool numLock = ShortcutBinding.NumLockEnabled;
                    bool environmentChanged = ReservationEnvironmentChanged(layout, numLock);
                    var desired = registrationSuspended && suspendedReservation is { } pendingReservation &&
                        layout == suspendedLayout && numLock == suspendedNumLock
                        ? pendingReservation : environmentChanged ? shortcut.Resolve(layout) : shortcut;
                    // The event settles Shift/NumLock interactions and keyboard-
                    // driver differences without confusing keypad/navigation keys.
                    if (mainKey && down && ChordModifiersDown() && shortcut.ScanCode != 0 && key.VirtualKey is > 0 and <= 0xFE)
                        desired = desired with { VirtualKey = key.VirtualKey };
                    if (environmentChanged || desired.VirtualKey != shortcut.VirtualKey || registrationSuspended)
                    {
                        if (!registrationRefreshPending && (environmentChanged || mainKey || shortcut.UsesModifier(virtualKey)))
                            RequestReservationRefresh(desired, layout, numLock);
                        return Win32.CallNextHookEx(hook, code, message, data);
                    }
                }
                if (registrationSuspended || registrationRefreshPending) return Win32.CallNextHookEx(hook, code, message, data);
                if (waitingForNeutral && (key.Flags & 0x12) == 0 && (down || up))
                {
                    // Include releases from a different physical key sharing
                    // the initial VK. No raw key is retained; the physical latch
                    // above remains authoritative once actually observed.
                    if (!ChordKeysDown(rawKey, down)) waitingForNeutral = false;
                    return Win32.CallNextHookEx(hook, code, message, data);
                }
                bool relevant = mainKey || shortcut.UsesModifier(virtualKey);
                bool chordKey = relevant || IsExcludedModifier(virtualKey);
                // Joining an extra modifier cancels the whole pending chord.
                // Do not synthesize released: only a new chord after all keys
                // return neutral may start another gesture.
                if (down && IsExcludedModifier(virtualKey))
                {
                    physicalPressed = false;
                    waitingForNeutral = true;
                }
                else if ((key.Flags & 0x12) != 0 && chordKey)
                {
                    physicalPressed = false;
                    waitingForNeutral = true;
                }
                else if ((key.Flags & 0x12) == 0 && (down || up) && chordKey)
                {
                    if (physicalPressed && up && relevant)
                    {
                        physicalPressed = false;
                        waitingForNeutral = ChordKeysDown(rawKey, false);
                        QueueSignal("released");
                    }
                    else if (!physicalPressed && down && mainKey && ChordModifiersDown())
                    {
                        var activationAnchor = ReadActivationAnchor();
                        physicalPressed = true;
                        QueueSignal("pressed");
                        QueueSignal("activated", activationAnchor);
                    }
                }
            }
        }
        catch
        {
            // Fail closed, but never let an exception escape an unmanaged hook.
            enabled = false;
            statusReason = "HOTKEY_UNAVAILABLE";
            try { window.Post(Disable); } catch { }
        }
        return Win32.CallNextHookEx(hook, code, message, data);
    }

    private static int NormalizeKey(int key) => key switch
    { 0xA0 or 0xA1 => Win32.Shift, 0xA2 or 0xA3 => Win32.Control, 0xA4 or 0xA5 => Win32.Alt, 0x5C => 0x5B, _ => key };
    private bool IsExcludedModifier(int key) => (key is Win32.Control or Win32.Alt or Win32.Shift or 0x5B) && !shortcut.UsesModifier(key);
    private bool ChordModifiersDown() => new[] { Win32.Control, Win32.Alt, Win32.Shift, 0x5B }.All(key =>
        (key == 0x5B ? Win32.Down(0x5B) || Win32.Down(0x5C) : Win32.Down(key)) == shortcut.UsesModifier(key));
    private bool ChordKeysDown(int changing, bool down)
    {
        // The hook precedes the asynchronous key-state update. Override only
        // the event's side so releasing left Ctrl cannot hide held right Ctrl.
        return mainPhysicalDown || new[] { (int)shortcut.VirtualKey, 0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0x5B, 0x5C }
            .Any(key => changing == key || ((changing is Win32.Shift or Win32.Control or Win32.Alt) && NormalizeKey(key) == changing)
                ? down : Win32.Down(key));
    }

    // Hook-side work is limited to a window handle, owning PID, and an atomic
    // epoch read. Never call UIA, inspect text, or query process tokens here.
    private ActivationAnchor? ReadActivationAnchor()
    {
        try
        {
            long epoch = Interlocked.Read(ref focusEpoch);
            long interaction = Interlocked.Read(ref interactionEpoch);
            nint foreground = Win32.GetForegroundWindow();
            int pid = Win32.WindowPid(foreground);
            return epoch == Interlocked.Read(ref focusEpoch) && interaction == Interlocked.Read(ref interactionEpoch)
                && foreground == Win32.GetForegroundWindow()
                ? new ActivationAnchor(foreground, pid, epoch, interaction) : null;
        }
        catch (CommandFailure) { return null; }
    }

    private bool ActivationAnchorMatches(ActivationAnchor? anchor)
    {
        if (anchor is null) return false;
        try
        {
            return InputTargetPolicy.ActivationMatches(anchor.Window, anchor.Pid, anchor.FocusEpoch, anchor.InteractionEpoch,
                    Win32.GetForegroundWindow(), Win32.WindowPid(anchor.Window), Interlocked.Read(ref focusEpoch), Interlocked.Read(ref interactionEpoch))
                && anchor.FocusEpoch == Interlocked.Read(ref focusEpoch)
                && anchor.InteractionEpoch == Interlocked.Read(ref interactionEpoch);
        }
        catch (CommandFailure) { return false; }
    }

    private void QueueSignal(string phase, ActivationAnchor? activationAnchor = null)
    {
        if (pendingSignals >= 8)
        {
            // Cancel immediately, but release UIA subscriptions only after the
            // hook returns. At most one cleanup joins the eight queued signals.
            enabled = false;
            hotkeyEpoch++;
            physicalPressed = false;
            waitingForNeutral = true;
            window.Post(() => { Disable(); statusReason = "INPUT_BUSY"; });
            return;
        }
        int epoch = hotkeyEpoch;
        pendingSignals++;
        window.Post(() =>
        {
            pendingSignals--;
            if (!enabled || epoch != hotkeyEpoch) return;
            string? targetId = null, reason = null;
            if (phase == "activated")
            {
                if (!ActivationAnchorMatches(activationAnchor)) reason = "TARGET_CHANGED";
                else
                {
                    try { targetId = Capture().targetId; }
                    catch (CommandFailure failure) { reason = failure.Code; }
                    bool capturedOriginal = targetId is null || (activationAnchor is not null && targets.TryGetValue(targetId, out var captured)
                        && captured.Focus.Window == activationAnchor.Window
                        && captured.Focus.Identity.Pid == activationAnchor.Pid
                        && captured.FocusEpoch == activationAnchor.FocusEpoch
                        && captured.InteractionEpoch == activationAnchor.InteractionEpoch);
                    if (!ActivationAnchorMatches(activationAnchor) || !capturedOriginal)
                    {
                        if (targetId is not null) Release(targetId);
                        targetId = null;
                        reason = "TARGET_CHANGED";
                    }
                }
            }
            if (!enabled || epoch != hotkeyEpoch)
            {
                if (targetId is not null) Release(targetId);
                return;
            }
            writer.Write(new { v = 1, @event = "hotkey", instanceId, sequence = ++sequence,
                generation, phase, targetId, reason });
        });
    }

    internal CapturedTarget Capture()
    {
        if (!enabled) throw new CommandFailure("INPUT_BUSY");
        ExpireTargets();
        if (targets.Count >= MaximumTargets) throw new CommandFailure("CAPACITY_EXCEEDED");
        try
        {
            long epoch = Interlocked.Read(ref focusEpoch);
            long capturedFocusOnlyEpoch = Interlocked.Read(ref focusOnlyEpoch);
            long capturedInteractionEpoch = Interlocked.Read(ref interactionEpoch);
            int captureGeneration = generation;
            var focus = SafeFocus();
            TextState textState = ReadText(focus);
            var id = Guid.NewGuid().ToString();
            string name;
            using (var process = Process.GetProcessById(focus.Identity.Pid)) name = process.ProcessName;
            name = new string(name.Where(c => !char.IsControl(c)).Take(128).ToArray());
            var target = new Target(focus, textState.Digest, textState.Selection?.Clone(), textState.NativeSelection,
                Stopwatch.GetTimestamp(), captureGeneration, epoch, capturedFocusOnlyEpoch, capturedInteractionEpoch, automationEvents);
            try
            {
                target.Subscribe();
                if (Interlocked.Read(ref focusEpoch) != epoch) throw new CommandFailure("TARGET_CHANGED");
                Revalidate(target);
                targets.Add(id, target);
            }
            catch { target.Dispose(); throw; }
            return new CapturedTarget(id, name);
        }
        catch (CommandFailure) { throw; }
        catch { throw new CommandFailure("TARGET_UNAVAILABLE"); }
    }

    internal object Release(string id)
    {
        if (targets.Remove(id, out var target)) target.Dispose();
        return new { released = true };
    }

    internal async Task<InsertResult> InsertAsync(Insertion request)
    {
        string fingerprint = Hash(request.SessionId + "\0" + request.TargetId + "\0" + request.Text);
        if (operations.TryGetValue(request.OperationId, out var existing))
            return existing.Fingerprint == fingerprint ? existing.Result : new InsertResult("notInserted", "OPERATION_CONFLICT");
        if (operations.Count >= MaximumOperations) throw new CommandFailure("CAPACITY_EXCEEDED");
        // Preallocate the result before consuming the token or calling any
        // provider. Even exception paths cannot cause a replayed side effect.
        var operation = new Operation(fingerprint, new InsertResult("partialOrUnknown", "DELIVERY_UNCONFIRMED"));
        operations.Add(request.OperationId, operation);
        targets.Remove(request.TargetId, out Target? target);
        try
        {
            if (target is null) return SetResult(operation, "notInserted", "TARGET_UNAVAILABLE");
            if (Stopwatch.GetElapsedTime(target.Created).TotalSeconds >= 600) return SetResult(operation, "notInserted", "TARGET_EXPIRED");
            if (!enabled || target.Generation != generation) return SetResult(operation, "notInserted", "CANCELLED");
            Revalidate(target);
            operation.Result = await paste.ExecuteAsync(request.Text, () =>
            {
                try
                {
                    Revalidate(target);
                    return Win32.ModifiersHeld() ? "MODIFIERS_HELD" : null;
                }
                catch (CommandFailure failure) { return failure.Code; }
                catch { return "TARGET_UNAVAILABLE"; }
            }, () =>
            {
                // Full UIA/security validation runs before the transaction's
                // final clipboard check. Keep only local checks here so another
                // slow provider call cannot widen the external-copy race.
                if (disposed || !enabled || target.Generation != generation || target.Invalidated
                    || target.FocusEpoch != Interlocked.Read(ref focusEpoch)
                    || target.FocusOnlyEpoch != Interlocked.Read(ref focusOnlyEpoch)
                    || target.Focus.Opaque && target.InteractionEpoch != Interlocked.Read(ref interactionEpoch))
                    throw new CommandFailure("TARGET_CHANGED");
                return Win32.SendPaste(target.Focus.Window, target.Focus.NativeWindow);
            });
            return operation.Result;
        }
        catch (CommandFailure failure) { return SetResult(operation, "notInserted", failure.Code); }
        catch { return SetResult(operation, "notInserted", "TARGET_UNAVAILABLE"); }
        finally { target?.Dispose(); }
    }

    private static InsertResult SetResult(Operation operation, string outcome, string? reason) => operation.Result = new InsertResult(outcome, reason);

    private Focus SafeFocus()
    {
        if (!Win32.DefaultDesktop()) throw new CommandFailure("PROTECTED_TARGET");
        RefreshOwnProcesses();
        nint windowHandle = Win32.GetForegroundWindow();
        int foregroundPid = Win32.WindowPid(windowHandle);
        // An unreadable security classification must not become the ordinary
        // no-target path, which is allowed to record recognition-only sessions.
        Win32.ProcessIdentity identity;
        try
        {
            identity = Win32.Identity(foregroundPid);
            var self = Win32.Identity(Environment.ProcessId);
            if (identity.Integrity > self.Integrity) throw new CommandFailure("PROTECTED_TARGET");
        }
        catch (CommandFailure) { throw; }
        catch { throw new CommandFailure("PROTECTED_TARGET"); }
        if (ownPids.Contains(foregroundPid) || excludedPids.Contains(foregroundPid)) throw new CommandFailure("OWN_APPLICATION");
        // UIA absence is a compatibility case, distinct from unreadable
        // process security. Inspect available protection attributes, never body.
        AutomationElement? element = null;
        try { element = AutomationElement.FocusedElement; } catch { }
        object? Property(AutomationProperty property)
        {
            try { return element?.GetCurrentPropertyValue(property, true); } catch { return null; }
        }
        object? elementPid = Property(AutomationElement.ProcessIdProperty);
        if (elementPid is int knownPid && knownPid > 0 && knownPid != foregroundPid)
            throw new CommandFailure("TARGET_CHANGED");
        if (Property(AutomationElement.IsEnabledProperty) is false)
            throw new CommandFailure("PROTECTED_TARGET");
        bool? password = Property(AutomationElement.IsPasswordProperty) as bool?;
        if (password is true) throw new CommandFailure("PROTECTED_TARGET");
        int[]? runtimeId = null;
        try { runtimeId = element?.GetRuntimeId(); } catch { }
        bool opaque = InputTargetPolicy.RequiresOpaqueFocus(element is not null,
            Property(AutomationElement.HasKeyboardFocusProperty) as bool?,
            Property(AutomationElement.IsKeyboardFocusableProperty) as bool?, password, runtimeId)
            || !Equals(elementPid, foregroundPid);
        nint nativeFocus = Win32.NativeFocus(windowHandle);
        if (Win32.GetForegroundWindow() != windowHandle || Win32.Identity(foregroundPid) != identity)
            throw new CommandFailure("TARGET_CHANGED");
        lock (focusNoticeGate)
        {
            if (noticedRuntimeId is null) { noticedWindow = windowHandle; noticedRuntimeId = runtimeId; }
        }
        return new Focus(windowHandle, identity, element, runtimeId, nativeFocus) { Opaque = opaque };
    }

    private void RefreshOwnProcesses()
    {
        if (parentCreated != Win32.CreationTime(parentPid)) throw new CommandFailure("TARGET_CHANGED");
        var parents = Win32.ProcessParents();
        bool added;
        do
        {
            added = false;
            foreach (var (pid, parent) in parents)
                if (ownPids.Contains(parent) && ownPids.Add(pid)) added = true;
        } while (added);
    }

    private TextState Revalidate(Target target)
    {
        if (!enabled || target.Generation != generation) throw new CommandFailure("INPUT_BUSY");
        if (target.Invalidated || target.FocusEpoch != Interlocked.Read(ref focusEpoch)
            || target.FocusOnlyEpoch != Interlocked.Read(ref focusOnlyEpoch)) throw new CommandFailure("TARGET_CHANGED");
        if (target.Focus.Opaque && target.InteractionEpoch != Interlocked.Read(ref interactionEpoch)) throw new CommandFailure("TARGET_CHANGED");
        var focus = SafeFocus();
        if (!SameTargetFocus(target.Focus, focus)) throw new CommandFailure("TARGET_CHANGED");
        focus.Opaque |= target.Focus.Opaque;
        TextState state = ReadText(focus);
        target.Focus.Opaque |= focus.Opaque;
        if (target.Digest is not null && state.Digest != target.Digest) throw new CommandFailure("TARGET_CHANGED");
        if (target.Selection is not null && state.Selection is null) throw new CommandFailure("TARGET_CHANGED");
        if (target.NativeSelection is not null && target.NativeSelection != state.NativeSelection)
            throw new CommandFailure("SELECTION_CHANGED");
        if (target.Selection is not null && state.Selection is not null && !target.Selection.Compare(state.Selection))
            throw new CommandFailure("SELECTION_CHANGED");
        if (!enabled || target.Generation != generation) throw new CommandFailure("INPUT_BUSY");
        if (target.Invalidated || target.FocusEpoch != Interlocked.Read(ref focusEpoch)
            || target.FocusOnlyEpoch != Interlocked.Read(ref focusOnlyEpoch)) throw new CommandFailure("TARGET_CHANGED");
        if (target.Focus.Opaque && target.InteractionEpoch != Interlocked.Read(ref interactionEpoch)) throw new CommandFailure("TARGET_CHANGED");
        return state;
    }

    private static bool SameTargetFocus(Focus captured, Focus current)
        => captured.Window == current.Window && captured.Identity == current.Identity && captured.NativeWindow == current.NativeWindow
            && (captured.Opaque || current.Opaque || (captured.RuntimeId is not null && current.RuntimeId is not null
                && captured.Element is not null && current.Element is not null
                && captured.RuntimeId.SequenceEqual(current.RuntimeId) && Automation.Compare(captured.Element, current.Element)));

    private static TextState ReadText(Focus focus)
    {
        AutomationElement? element = focus.Element;
        bool? valueReadOnly = null, textReadOnly = null;
        TextPattern? text = null;
        TextPatternRange? selection = null;
        string? digest = null;
        // Read protection/capability before content. A failed/unsupported pattern
        // is unknown, not proof that the control is writable.
        try
        {
            if (element is not null && element.TryGetCurrentPattern(ValuePattern.Pattern, out object valueObject) && valueObject is ValuePattern value)
                valueReadOnly = value.Current.IsReadOnly;
        }
        catch { }
        try
        {
            if (element is not null && element.TryGetCurrentPattern(TextPattern.Pattern, out object textObject) && textObject is TextPattern pattern)
            {
                text = pattern;
                object readOnly = text.DocumentRange.GetAttributeValue(TextPattern.IsReadOnlyAttribute);
                if (readOnly is bool flag) textReadOnly = flag;
            }
        }
        catch { }
        // Protection belongs to the actual native focus, even when UIA exposes
        // only its parent window. Never let an opaque provider hide ES_PASSWORD.
        var native = Win32.FocusedNativeText(focus.Window, focus.NativeWindow);
        if (valueReadOnly is true || textReadOnly is true || native is { Password: true } or { ReadOnly: true })
            throw new CommandFailure("PROTECTED_TARGET");
        if (!InputTargetPolicy.Allows(!focus.Opaque, false, textReadOnly, valueReadOnly, native is not null))
            focus.Opaque = true;
        // The opaque route never reads body/selection from a provider
        // whose password classification is unknown. No UIA proof is fabricated.
        if (focus.Opaque)
        {
            if (Win32.MouseButtonsHeld()) throw new CommandFailure("TARGET_CHANGED");
            return new TextState(null, null, null, null);
        }
        if (text is not null)
        {
            try
            {
                var selections = text.GetSelection();
                if (selections.Length == 1) selection = selections[0];
                else if (selections.Length > 1) throw new CommandFailure("SELECTION_CHANGED");
            }
            catch (CommandFailure) { throw; }
            catch { }
            try { digest = Hash(BoundedText(text.DocumentRange)); }
            catch { } // inaccessible/large text remains opaque writable capability
        }
        return new TextState(digest, selection, text, native);
    }

    private static string BoundedText(TextPatternRange range)
    {
        string text = range.GetText(MaximumObservedText + 1);
        if (text.Length > MaximumObservedText) throw new CommandFailure("TARGET_UNAVAILABLE");
        return text;
    }
    private static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.Unicode.GetBytes(text)));
    private void ExpireTargets()
    {
        foreach (var (id, target) in targets.ToArray())
            if (Stopwatch.GetElapsedTime(target.Created).TotalSeconds >= 600) { targets.Remove(id); target.Dispose(); }
    }
    private void ClearTargets()
    {
        var previous = targets.Values.ToArray();
        targets.Clear();
        foreach (var target in previous) target.Dispose();
    }
    public void Dispose()
    {
        if (disposed) return;
        disposed = true;
        Disable();
        continuitySubscription?.Dispose(); continuitySubscription = null;
        automationEvents.Dispose();
        paste.Dispose();
        operations.Clear();
    }

    internal Task ShutdownAsync() => paste.ShutdownAsync();

    private sealed record Focus(nint Window, Win32.ProcessIdentity Identity, AutomationElement? Element, int[]? RuntimeId, nint NativeWindow)
    { internal bool Opaque { get; set; } }
    private sealed record ActivationAnchor(nint Window, int Pid, long FocusEpoch, long InteractionEpoch);
    private sealed class Target(Focus focus, string? digest, TextPatternRange? selection, Win32.NativeTextCapability? nativeSelection, long created, int generation, long focusEpoch, long focusOnlyEpoch, long interactionEpoch, WindowsAutomationEvents automationEvents) : IDisposable
    {
        internal Focus Focus { get; } = focus;
        internal string? Digest { get; } = digest;
        internal TextPatternRange? Selection { get; } = selection;
        internal Win32.NativeTextCapability? NativeSelection { get; } = nativeSelection;
        internal long Created { get; } = created;
        internal int Generation { get; } = generation;
        internal long FocusEpoch { get; } = focusEpoch;
        internal long FocusOnlyEpoch { get; } = focusOnlyEpoch;
        internal long InteractionEpoch { get; } = interactionEpoch;
        private int invalidated;
        internal bool Invalidated => Volatile.Read(ref invalidated) != 0;
        private IDisposable? subscription;
        internal void Subscribe()
        {
            if (Focus.Opaque || Focus.Element is null) return;
            subscription = automationEvents.SubscribeTarget(Focus.Element,
                () => Interlocked.Exchange(ref invalidated, 1));
        }
        public void Dispose()
        {
            // Revoke the target immediately; provider cleanup runs separately
            // and cannot turn a submitted paste into an IPC timeout/fallback.
            Interlocked.Exchange(ref invalidated, 1);
            Interlocked.Exchange(ref subscription, null)?.Dispose();
        }
    }
    private sealed record TextState(string? Digest, TextPatternRange? Selection, TextPattern? Text, Win32.NativeTextCapability? NativeSelection);
    private sealed class Operation(string fingerprint, InsertResult result)
    {
        internal string Fingerprint { get; } = fingerprint;
        internal InsertResult Result { get; set; } = result;
    }
}

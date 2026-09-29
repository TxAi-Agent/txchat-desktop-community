using System.Collections.Concurrent;
using System.Windows.Automation;

// UIA event registration/removal must share one windowless MTA thread. In
// particular, removal must never hold the input/IPC STA while a provider stalls.
internal sealed class WindowsAutomationEvents : IDisposable
{
    private readonly BlockingCollection<Action> queue = new(64);
    private readonly object gate = new();
    private bool closed, unavailable;

    internal WindowsAutomationEvents()
    {
        var thread = new Thread(() =>
        {
            foreach (var action in queue.GetConsumingEnumerable())
                try { action(); } catch { /* Each registration owns its failure. */ }
        }) { IsBackground = true, Name = "TxChat Community UIA event lifecycle" };
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
    }

    internal IDisposable SubscribeContinuity(AutomationFocusChangedEventHandler focus,
        AutomationEventHandler selection)
    {
        AutomationElement? root = null;
        AutomationFocusChangedEventHandler? focusHandler = null;
        AutomationEventHandler? selectionHandler = null;
        return Subscribe(alive =>
        {
            focusHandler = (sender, args) => { if (alive()) focus(sender, args); };
            selectionHandler = (sender, args) => { if (alive()) selection(sender, args); };
            root = AutomationElement.RootElement;
            Automation.AddAutomationFocusChangedEventHandler(focusHandler);
            Automation.AddAutomationEventHandler(TextPattern.TextSelectionChangedEvent,
                root, TreeScope.Subtree, selectionHandler);
        }, () =>
        {
            if (focusHandler is not null)
                try { Automation.RemoveAutomationFocusChangedEventHandler(focusHandler); } catch { }
            if (root is not null && selectionHandler is not null)
                try { Automation.RemoveAutomationEventHandler(TextPattern.TextSelectionChangedEvent, root, selectionHandler); } catch { }
        });
    }

    internal IDisposable SubscribeTarget(AutomationElement element, Action invalidate)
    {
        AutomationEventHandler? selection = null, text = null;
        AutomationPropertyChangedEventHandler? value = null;
        return Subscribe(alive =>
        {
            selection = (_, _) => { if (alive()) invalidate(); };
            text = (_, _) => { if (alive()) invalidate(); };
            value = (_, _) => { if (alive()) invalidate(); };
            Automation.AddAutomationEventHandler(TextPattern.TextSelectionChangedEvent, element, TreeScope.Element, selection);
            Automation.AddAutomationEventHandler(TextPattern.TextChangedEvent, element, TreeScope.Element, text);
            Automation.AddAutomationPropertyChangedEventHandler(element, TreeScope.Element, value, ValuePattern.ValueProperty);
        }, () =>
        {
            if (selection is not null)
                try { Automation.RemoveAutomationEventHandler(TextPattern.TextSelectionChangedEvent, element, selection); } catch { }
            if (value is not null)
                try { Automation.RemoveAutomationPropertyChangedEventHandler(element, value); } catch { }
            if (text is not null)
                try { Automation.RemoveAutomationEventHandler(TextPattern.TextChangedEvent, element, text); } catch { }
        });
    }

    internal IDisposable Subscribe(Action<Func<bool>> install, Action remove)
    {
        var registration = new Registration(this, remove);
        var ready = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate)
        {
            if (closed || unavailable || !queue.TryAdd(() =>
            {
                try
                {
                    if (registration.Alive) install(() => registration.Alive);
                    if (!registration.Alive) registration.Clean();
                    ready.TrySetResult(true);
                }
                catch
                {
                    registration.Invalidate();
                    ready.TrySetResult(false);
                    registration.Clean();
                }
            })) throw new CommandFailure("HOTKEY_UNAVAILABLE");
        }
        // A slow or dead provider cannot consume the supervisor's full timeout.
        if (!ready.Task.Wait(1500) || !ready.Task.Result)
        {
            registration.Dispose();
            throw new CommandFailure("HOTKEY_UNAVAILABLE");
        }
        return registration;
    }

    private void Release(Registration registration)
    {
        lock (gate)
        {
            if (closed) return;
            // Invalidation is already synchronous. Refuse further registrations
            // if cleanup is backlogged, instead of accumulating active handlers.
            if (!queue.TryAdd(registration.Clean)) unavailable = true;
        }
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (closed) return;
            closed = true;
            queue.CompleteAdding();
        }
        // The background worker drains cleanup; process exit also releases UIA.
        // Never join a provider-bound thread from the input/IPC dispatcher.
    }

    private sealed class Registration(WindowsAutomationEvents owner, Action remove) : IDisposable
    {
        private int disposed;
        private bool cleaned; // Accessed only on the lifecycle worker.
        internal bool Alive => Volatile.Read(ref disposed) == 0;
        internal void Invalidate() => Interlocked.Exchange(ref disposed, 1);
        internal void Clean() { if (cleaned) return; cleaned = true; try { remove(); } catch { } }
        public void Dispose() { if (Interlocked.Exchange(ref disposed, 1) == 0) owner.Release(this); }
    }
}

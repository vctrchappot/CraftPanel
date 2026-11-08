// Compiled with windows-job.ps1 by the Windows installer; no external service wrapper.
// Receives SCM preshutdown before Windows stops services. Games run as this service's
// virtual account, in its own job, independently of the dashboard's scheduled task.
public static class CraftPanelRuntimeService {
    const uint STOPPED = 1, START_PENDING = 2, STOP_PENDING = 3, RUNNING = 4;
    const uint ACCEPT_STOP = 1, ACCEPT_SHUTDOWN = 4, ACCEPT_PRESHUTDOWN = 256;
    static string name, node, entry, directory, data, config;
    static System.IntPtr handle;
    static readonly System.Threading.ManualResetEvent ended = new System.Threading.ManualResetEvent(false);
    static readonly object statusLock = new object();
    static int stopping;
    static uint checkpoint;
    delegate void ServiceMain(int argc, System.IntPtr argv);
    delegate uint ControlHandler(uint control, uint eventType, System.IntPtr eventData, System.IntPtr context);
    static readonly ServiceMain main = MainService;
    static readonly ControlHandler control = HandleControl;
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential, CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    struct TableEntry { [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] public string Name; public ServiceMain Main; }
    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    struct Status { public uint Type, State, Accepted, Win32Exit, ServiceExit, Checkpoint, WaitHint; }
    [System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    static extern bool StartServiceCtrlDispatcher([System.Runtime.InteropServices.In] TableEntry[] table);
    [System.Runtime.InteropServices.DllImport("advapi32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode, SetLastError = true)]
    static extern System.IntPtr RegisterServiceCtrlHandlerEx(string serviceName, ControlHandler handler, System.IntPtr context);
    [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetServiceStatus(System.IntPtr statusHandle, ref Status status);

    public static int Main(string[] args) {
        if (args.Length != 6) return 2;
        name = args[0]; node = args[1]; entry = args[2]; directory = args[3]; data = args[4]; config = args[5];
        var table = new TableEntry[] { new TableEntry { Name = name, Main = main }, new TableEntry() };
        return StartServiceCtrlDispatcher(table) ? 0 : System.Runtime.InteropServices.Marshal.GetLastWin32Error();
    }
    static void Report(uint state, uint error = 0) {
        lock (statusLock) {
            var status = new Status { Type = 0x10, State = state, Accepted = state == RUNNING ? ACCEPT_STOP | ACCEPT_SHUTDOWN | ACCEPT_PRESHUTDOWN : 0,
                Win32Exit = error, Checkpoint = state == STOP_PENDING || state == START_PENDING ? ++checkpoint : 0, WaitHint = 120000 };
            if (!SetServiceStatus(handle, ref status)) throw new System.ComponentModel.Win32Exception(System.Runtime.InteropServices.Marshal.GetLastWin32Error());
        }
    }
    static void MainService(int argc, System.IntPtr argv) {
        handle = RegisterServiceCtrlHandlerEx(name, control, System.IntPtr.Zero);
        if (handle == System.IntPtr.Zero) return;
        Report(START_PENDING);
        try {
            if (System.IO.File.Exists(config)) foreach (var line in System.IO.File.ReadAllLines(config)) {
                var m = System.Text.RegularExpressions.Regex.Match(line, @"^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$");
                if (m.Success) System.Environment.SetEnvironmentVariable(m.Groups[1].Value, m.Groups[2].Value.Trim('"'));
            }
            System.Environment.SetEnvironmentVariable("CRAFTPANEL_DATA_DIR", data);
            System.Environment.SetEnvironmentVariable("NODE_ENV", "production");
            var logs = System.IO.Path.Combine(data, "logs");
            System.IO.Directory.CreateDirectory(logs);
            Report(RUNNING);
            int code = CraftPanelJob.Run(node, entry, directory, System.IO.Path.Combine(logs, "runtime.log"), System.IO.Path.Combine(logs, "runtime.err.log"));
            Report(STOPPED, code == 0 ? 0u : 1066u);
        } catch (System.Exception e) {
            try { System.IO.File.AppendAllText(System.IO.Path.Combine(data, "logs", "runtime-host.err.log"), e.ToString() + System.Environment.NewLine); } catch {}
            Report(STOPPED, 1066);
        } finally { ended.Set(); }
    }
    static uint HandleControl(uint code, uint eventType, System.IntPtr eventData, System.IntPtr context) {
        if (code == 1 || code == 5 || code == 15) {
            if (System.Threading.Interlocked.Exchange(ref stopping, 1) == 0) {
                Report(STOP_PENDING);
                new System.Threading.Thread(Shutdown).Start();
            }
        } else if (code == 4) Report(stopping == 0 ? RUNNING : STOP_PENDING);
        return 0;
    }
    static void Shutdown() {
        try {
            var start = new System.Diagnostics.ProcessStartInfo(node, "\"" + entry + "\" --shutdown") {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = directory
            };
            using (var child = System.Diagnostics.Process.Start(start)) { if (!child.WaitForExit(10000)) child.Kill(); }
            for (int i = 0; i < 110 && !ended.WaitOne(1000); i++) Report(STOP_PENDING);
        } catch (System.Exception e) {
            try { System.IO.File.AppendAllText(System.IO.Path.Combine(data, "logs", "runtime-host.err.log"), "Shutdown failed: " + e.ToString()); } catch {}
        }
        // No blind TerminateProcess: SCM's timeout remains visible if graceful saving failed.
    }
}

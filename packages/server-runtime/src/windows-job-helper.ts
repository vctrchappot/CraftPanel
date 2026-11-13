/**
 * C# source of the helper that keeps one server in its own job object. The runtime compiles it
 * with the .NET Framework compiler that ships with Windows (no native add-ons, nothing downloaded).
 * Usage: job-helper <pid> <memoryMb> <cpuPercent> <processes>, 0 = unlimited.
 * stdin: "limits <memoryMb> <cpuPercent> <processes>", "kill". stdout: ready, ok, error <message>, memory-limit, process-limit.
 * https://learn.microsoft.com/windows/win32/procthread/job-objects
 */
export const JOB_HELPER_SOURCE = String.raw`using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public static class CraftPanelServerJob {
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters {
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
    }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
        public BasicLimits Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)] struct CpuRate { public uint Flags, Rate; }
    [StructLayout(LayoutKind.Sequential)] struct CompletionPort { public IntPtr Key, Port; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref CpuRate info, int size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int kind, ref CompletionPort info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateIoCompletionPort(IntPtr file, IntPtr existing, UIntPtr key, uint threads);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetQueuedCompletionStatus(IntPtr port, out uint message, out IntPtr key, out IntPtr overlapped, uint milliseconds);

    static IntPtr job;
    static bool cpuLimited;
    static readonly object output = new object();
    static void Say(string line) { lock (output) { Console.Out.WriteLine(line); Console.Out.Flush(); } }
    static void Check(bool result) { if (!result) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static long Number(string value) { return long.Parse(value, NumberStyles.None, CultureInfo.InvariantCulture); }

    static void Apply(long memoryMb, long cpuPercent, long processes) {
        var limits = new ExtendedLimits();
        // Committed memory of every process in the job; allocations above it fail.
        if (memoryMb > 0) { limits.Basic.Flags |= 0x200; limits.JobMemory = new UIntPtr((ulong)memoryMb * 1048576UL); }
        if (processes > 0) { limits.Basic.Flags |= 0x8; limits.Basic.ActiveProcesses = (uint)processes; }
        Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))));
        // Hard cap in 1/100 percent of all processors; 100 percent is one core here.
        // Windows refuses an empty rate on a job that never had one.
        if (cpuPercent <= 0 && !cpuLimited) return;
        var rate = new CpuRate();
        if (cpuPercent > 0) { rate.Flags = 0x5; rate.Rate = (uint)Math.Max(1, Math.Min(10000, cpuPercent * 100 / Environment.ProcessorCount)); }
        Check(SetInformationJobObject(job, 15, ref rate, Marshal.SizeOf(typeof(CpuRate))));
        cpuLimited = cpuPercent > 0;
    }

    static void Watch(IntPtr port) {
        uint message; IntPtr key, overlapped;
        while (GetQueuedCompletionStatus(port, out message, out key, out overlapped, 0xffffffff)) {
            if (message == 10) Say("memory-limit");
            else if (message == 3) Say("process-limit");
        }
    }

    public static int Main(string[] args) {
        try {
            if (args.Length != 4) throw new ArgumentException("Usage: job-helper <pid> <memoryMb> <cpuPercent> <processes>");
            // PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION
            IntPtr process = OpenProcess(0x0100 | 0x0001 | 0x1000, false, (int)Number(args[0]));
            Check(process != IntPtr.Zero);
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero);
            IntPtr port = CreateIoCompletionPort(new IntPtr(-1), IntPtr.Zero, UIntPtr.Zero, 1);
            Check(port != IntPtr.Zero);
            var association = new CompletionPort { Key = job, Port = port };
            Check(SetInformationJobObject(job, 7, ref association, Marshal.SizeOf(typeof(CompletionPort))));
            Apply(Number(args[1]), Number(args[2]), Number(args[3]));
            // Nests inside any job the process is already in; no kill-on-close, the server outlives this helper.
            Check(AssignProcessToJobObject(job, process));
            new Thread(() => Watch(port)) { IsBackground = true }.Start();
            Say("ready");
        } catch (Exception e) { Say("error " + e.Message); return 1; }
        string line;
        while ((line = Console.In.ReadLine()) != null) {
            try {
                var parts = line.Split(' ');
                if (parts.Length == 4 && parts[0] == "limits") Apply(Number(parts[1]), Number(parts[2]), Number(parts[3]));
                else if (line == "kill") TerminateJobObject(job, 1);
                else throw new ArgumentException("Unknown command");
                Say("ok");
            } catch (Exception e) { Say("error " + e.Message); }
        }
        return 0;
    }
}
`;

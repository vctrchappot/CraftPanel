/**
 * C# source of the helper that runs one server under a restricted token. The runtime compiles it
 * with the .NET Framework compiler that ships with Windows (no native add-ons, nothing downloaded).
 *
 * run <serverSid> <tempDir> -- <file> [args...]
 *   Starts the file with a restricted copy of the helper's own token, suspended, puts it into a
 *   kill-on-close job, prints "craftpanel-pid <pid>" on stdout and resumes it. The game shares the
 *   helper's stdin/stdout/stderr; the helper waits and exits with the game's exit code. When the
 *   helper dies, the job closes and takes the game and anything it started with it.
 * prepare <serverSid> <dataDir> <serverDir> <tempDir> <file> <fileRoot>
 *   Grants the server SID on its directories, lets the restricted token list the data directory's
 *   folders on the way to them and read a Java runtime inside it, then checks under that token what
 *   the game can reach. stdout: "problem <message>" lines, "warn <message>" lines, then "ok".
 *
 * Access checks on a restricted token pass only if both the account and one of the restricting SIDs
 * are granted: the account keeps the runtime's own access, the restricting SIDs (this server, Everyone,
 * Users, Authenticated Users, RESTRICTED) narrow it to what any local user could reach plus the server's
 * own folders. Network access, loopback included, is unchanged.
 * https://learn.microsoft.com/windows/win32/secauthz/restricted-tokens
 */
export const TOKEN_HELPER_SOURCE = String.raw`using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class CraftPanelServerToken {
    [StructLayout(LayoutKind.Sequential)] struct SidAndAttributes { public IntPtr Sid; public uint Attributes; }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
        public int cb; public string Reserved, Desktop, Title; public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
        public short ShowWindow, Reserved2; public IntPtr Reserved2Ptr, StdInput, StdOutput, StdError;
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public int ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
        public long ProcessTime, JobTime; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits { public BasicLimits Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory; }

    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint disableCount, SidAndAttributes[] disable, uint deleteCount, IntPtr delete, uint restrictCount, SidAndAttributes[] restrict, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int kind, ref IntPtr info, int length);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool DuplicateToken(IntPtr token, int level, out IntPtr duplicate);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr token, string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes,
        bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInformation info);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits info, int size);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);

    const string Restricted = "S-1-5-12";
    const FileSystemRights List = FileSystemRights.ListDirectory | FileSystemRights.Traverse | FileSystemRights.ReadAttributes | FileSystemRights.Synchronize;
    const FileSystemRights Read = FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize;
    const FileSystemRights Change = FileSystemRights.Modify | FileSystemRights.Synchronize;

    static void Check(bool result, string what) { if (!result) throw new Exception(what + ": " + new Win32Exception(Marshal.GetLastWin32Error()).Message); }

    static SidAndAttributes Sid(string value) {
        var sid = new SecurityIdentifier(value);
        var bytes = new byte[sid.BinaryLength];
        sid.GetBinaryForm(bytes, 0);
        IntPtr native = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, native, bytes.Length);
        return new SidAndAttributes { Sid = native };
    }

    /** A restricted copy of this process's token: no privileges but traversal, no administrators, only the listed SIDs pass the second check. */
    static IntPtr Token(string serverSid) {
        IntPtr token, restricted;
        // TOKEN_ASSIGN_PRIMARY | TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ADJUST_DEFAULT
        Check(OpenProcessToken(GetCurrentProcess(), 0x1 | 0x2 | 0x8 | 0x80, out token), "OpenProcessToken");
        var restrict = new List<SidAndAttributes>();
        foreach (var sid in new[] { serverSid, "S-1-1-0", "S-1-5-32-545", "S-1-5-11", Restricted }) restrict.Add(Sid(sid));
        var disable = new[] { Sid("S-1-5-32-544") };
        // DISABLE_MAX_PRIVILEGE keeps only SeChangeNotifyPrivilege (traversal).
        Check(CreateRestrictedToken(token, 0x1, (uint)disable.Length, disable, 0, IntPtr.Zero, (uint)restrict.Count, restrict.ToArray(), out restricted), "CreateRestrictedToken");
        // Objects the game creates without a parent to inherit from (its own process, threads, events) stay usable for it and the runtime.
        IntPtr descriptor, dacl; bool present, defaulted;
        string user = WindowsIdentity.GetCurrent().User.Value;
        Check(ConvertStringSecurityDescriptorToSecurityDescriptor("D:(A;;GA;;;SY)(A;;GA;;;" + user + ")(A;;GA;;;" + serverSid + ")", 1, out descriptor, IntPtr.Zero), "Default DACL");
        Check(GetSecurityDescriptorDacl(descriptor, out present, out dacl, out defaulted), "GetSecurityDescriptorDacl");
        Check(SetTokenInformation(restricted, 6, ref dacl, IntPtr.Size), "SetTokenInformation");
        return restricted;
    }

    // CommandLineToArgvW / MSVC CRT rules, as Java parses them.
    static string Quote(string arg) {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
        var sb = new StringBuilder("\"");
        for (int i = 0; ; i++) {
            int slashes = 0;
            while (i < arg.Length && arg[i] == '\\') { slashes++; i++; }
            if (i == arg.Length) { sb.Append('\\', slashes * 2); break; }
            if (arg[i] == '"') sb.Append('\\', slashes * 2 + 1).Append('"');
            else sb.Append('\\', slashes).Append(arg[i]);
        }
        return sb.Append('"').ToString();
    }

    static int Run(string[] args) {
        if (args.Length < 5 || args[3] != "--") throw new ArgumentException("Usage: run <serverSid> <tempDir> -- <file> [args...]");
        IntPtr token = Token(args[1]);
        var env = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry e in Environment.GetEnvironmentVariables()) env[(string)e.Key] = (string)e.Value;
        // The account's own temp folder is out of reach; Java, JNA and Netty unpack libraries there.
        env["TEMP"] = args[2]; env["TMP"] = args[2];
        var block = new StringBuilder();
        foreach (var e in env) block.Append(e.Key).Append('=').Append(e.Value).Append('\0');
        block.Append('\0');
        var line = new StringBuilder();
        for (int i = 4; i < args.Length; i++) { if (i > 4) line.Append(' '); line.Append(Quote(args[i])); }
        var startup = new StartupInfo { cb = Marshal.SizeOf(typeof(StartupInfo)), Flags = 0x100, StdInput = GetStdHandle(-10), StdOutput = GetStdHandle(-11), StdError = GetStdHandle(-12) };
        ProcessInformation info;
        // CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT
        Check(CreateProcessAsUser(token, args[4], line, IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x400, Marshal.StringToHGlobalUni(block.ToString()), null, ref startup, out info), "CreateProcessAsUser");
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // KILL_ON_JOB_CLOSE
        if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(ExtendedLimits))) || !AssignProcessToJobObject(job, info.Process)) {
            int error = Marshal.GetLastWin32Error();
            TerminateProcess(info.Process, 1);
            throw new Exception("Job object: " + new Win32Exception(error).Message);
        }
        Console.Out.WriteLine("craftpanel-pid " + info.ProcessId);
        Console.Out.Flush();
        ResumeThread(info.Thread);
        WaitForSingleObject(info.Process, 0xffffffff);
        uint code;
        GetExitCodeProcess(info.Process, out code);
        return (int)code;
    }

    static bool Inside(string path, string root) {
        return path.Equals(root, StringComparison.OrdinalIgnoreCase) || path.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }

    /** Adds an allow rule unless one with at least these rights is there. Needs WRITE_DAC; changing an inheritable rule updates the tree once. */
    static void Grant(string dir, string sid, FileSystemRights rights, bool inherit) {
        var info = new DirectoryInfo(dir);
        var security = info.GetAccessControl(AccessControlSections.Access);
        var identity = new SecurityIdentifier(sid);
        var flags = inherit ? InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit : InheritanceFlags.None;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, false, typeof(SecurityIdentifier))) {
            if (rule.AccessControlType == AccessControlType.Allow && rule.IdentityReference.Equals(identity) && (rule.FileSystemRights & rights) == rights &&
                (rule.InheritanceFlags & flags) == flags && rule.PropagationFlags == PropagationFlags.None) return;
        }
        security.AddAccessRule(new FileSystemAccessRule(identity, rights, flags, PropagationFlags.None, AccessControlType.Allow));
        info.SetAccessControl(security);
    }

    static string Prepare(string[] args) {
        if (args.Length != 7) throw new ArgumentException("Usage: prepare <serverSid> <dataDir> <serverDir> <tempDir> <file> <fileRoot>");
        string sid = args[1], data = Path.GetFullPath(args[2]), server = Path.GetFullPath(args[3]), temp = Path.GetFullPath(args[4]), file = Path.GetFullPath(args[5]), fileRoot = Path.GetFullPath(args[6]);
        var problems = new List<string>();
        var warnings = new List<string>();
        foreach (var dir in new[] { server, temp }) {
            try { Grant(dir, sid, Change, true); }
            catch (Exception e) { problems.Add("The runtime cannot give the server access to " + dir + " (" + e.Message + "). Grant the runtime service account Modify and Change permissions on it, or move the server into the data directory."); }
        }
        // Inside the data directory the runtime may change permissions; above it the installer did.
        var ancestors = new List<string>();
        foreach (var target in new[] { server, fileRoot }) {
            for (var dir = Path.GetDirectoryName(target); dir != null; dir = Path.GetDirectoryName(dir)) if (!ancestors.Contains(dir)) ancestors.Add(dir);
        }
        foreach (var dir in ancestors) if (Inside(dir, data)) try { Grant(dir, Restricted, List, false); } catch { }
        if (Inside(fileRoot, data) && !Inside(fileRoot, server)) try { Grant(fileRoot, Restricted, Read, true); } catch { }

        IntPtr impersonation;
        Check(DuplicateToken(Token(sid), 2, out impersonation), "DuplicateToken");
        using (WindowsIdentity.Impersonate(impersonation)) {
            // Java resolves real paths by listing every ancestor of the server directory (Paperclip).
            for (var dir = Path.GetDirectoryName(server); dir != null; dir = Path.GetDirectoryName(dir)) {
                try { using (var e = Directory.EnumerateFileSystemEntries(dir).GetEnumerator()) e.MoveNext(); }
                catch (Exception) { problems.Add("The server cannot list " + dir + ", a folder above its directory. Grant RESTRICTED (S-1-5-12) List folder contents there: icacls \"" + dir + "\" /grant *S-1-5-12:(RD,X,RA,S)"); break; }
            }
            foreach (var dir in new[] { server, temp }) {
                string probe = Path.Combine(dir, ".craftpanel-access-" + Guid.NewGuid().ToString("N"));
                try { File.WriteAllText(probe, ""); File.Delete(probe); }
                catch (Exception) { problems.Add("The server cannot write " + dir); }
            }
            try { using (new FileStream(file, FileMode.Open, FileSystemRights.ReadAndExecute, FileShare.ReadWrite | FileShare.Delete, 4096, FileOptions.None)) { } }
            catch (Exception) { problems.Add("The server cannot run " + file + ". Use a Java installation readable by Users, or grant RESTRICTED (S-1-5-12) Read & execute: icacls \"" + fileRoot + "\" /grant *S-1-5-12:(OI)(CI)RX"); }
            // The point of all this: the panel's secrets must stay out of reach.
            foreach (var secret in new[] { Path.Combine(data, "craftpanel.db"), Path.Combine(data, "runtime", "token") }) {
                try { using (File.OpenRead(secret)) { } warnings.Add("Game processes can read " + secret + ". Remove access for Users, Authenticated Users and Everyone from " + data + "."); }
                catch (Exception) { }
            }
        }
        var output = new StringBuilder();
        foreach (var p in problems) output.Append("problem ").Append(p.Replace('\n', ' ')).Append('\n');
        foreach (var w in warnings) output.Append("warn ").Append(w.Replace('\n', ' ')).Append('\n');
        return output.Append("ok").ToString();
    }

    public static int Main(string[] args) {
        try {
            if (args.Length > 0 && args[0] == "run") return Run(args);
            if (args.Length > 0 && args[0] == "prepare") { Console.Out.WriteLine(Prepare(args)); return 0; }
            throw new ArgumentException("Usage: run ... | prepare ...");
        } catch (Exception e) {
            Console.Error.WriteLine("CraftPanel could not start the server under its restricted token: " + e.Message);
            return 1;
        }
    }
}
`;

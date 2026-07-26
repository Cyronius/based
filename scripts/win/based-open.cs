// Traces: BASED-SQL-ASSOC-WIN, BASED-OPEN-SQL-ARGV
//
// File-association stub for based. Electrobun's launcher.exe does not forward its argv to the
// bun process (verified against 1.18.1: it spawns `bun.exe main.js` with exactly those two
// args), so the `.sql` "open" verb points here instead. This stub:
//   1. appends the requested path (one per line) to <dataDir>\pending-open.txt, and
//   2. starts launcher.exe with BASED_STUB_OPEN=1 in its environment.
// The shell (shell/src/bun/pendingOpens.ts + singleInstance.ts) consumes the file — directly
// when it becomes the primary instance, or by forwarding to the running primary otherwise.
// BASED_STUB_OPEN lets a stub-spawned shell that finds nothing pending (another instance already
// consumed it) exit quietly instead of opening a blank window.
//
// Compiled at package time by scripts/package-win.ps1 with the .NET Framework csc that ships on
// every Windows 10/11 box: /target:winexe (GUI subsystem — no console flash on double-click).
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

static class BasedOpen
{
    static void Main(string[] args)
    {
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string launcher = Path.Combine(exeDir, "launcher.exe");

        if (args.Length > 0)
        {
            string dataDir = Environment.GetEnvironmentVariable("BASED_DATA_DIR");
            if (string.IsNullOrEmpty(dataDir))
                dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "based");
            try { Directory.CreateDirectory(dataDir); } catch { }
            string pending = Path.Combine(dataDir, "pending-open.txt");

            foreach (string arg in args)
            {
                string full;
                try { full = Path.GetFullPath(arg); } catch { continue; }
                if (!File.Exists(full)) continue;
                // Concurrent stubs (rapid multi-select "Open") can collide on the append; retry
                // briefly rather than lock — the file is tiny and contention is milliseconds.
                for (int attempt = 0; attempt < 20; attempt++)
                {
                    try { File.AppendAllText(pending, full + Environment.NewLine); break; }
                    catch (IOException) { Thread.Sleep(25); }
                }
            }
        }

        if (!File.Exists(launcher)) return;
        var psi = new ProcessStartInfo
        {
            FileName = launcher,
            UseShellExecute = false,
            WorkingDirectory = exeDir,
        };
        psi.EnvironmentVariables["BASED_STUB_OPEN"] = "1";
        try { Process.Start(psi); } catch { }
    }
}

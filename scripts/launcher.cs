// Amadeus.exe - connector launcher.
//
// Double-clicking this (or a shortcut to it) starts the daemon if needed and
// opens the panel as its own application window. Codex does not need it: the
// plugin's SessionStart hook calls bin/amadeus-panel.mjs directly.
//
// Built by scripts/build-launcher.ps1 with the .NET Framework compiler that
// ships with Windows. ASCII only: the build script is read as ANSI.
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class AmadeusLauncher
{
    [STAThread]
    static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string script = Path.Combine(root, "bin", "amadeus-panel.mjs");
        try
        {
            if (!File.Exists(script))
            {
                MessageBox.Show(
                    "Amadeus is not installed correctly.\r\n\r\nMissing: " + script,
                    "Amadeus",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
                return 1;
            }

            ProcessStartInfo start = new ProcessStartInfo();
            start.FileName = "node";
            start.Arguments = "\"" + script + "\" --silent --welcome";
            start.WorkingDirectory = root;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            Process.Start(start);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "Could not start Amadeus: " + error.Message +
                "\r\n\r\nNode.js 22 or newer must be on PATH.",
                "Amadeus",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }
}

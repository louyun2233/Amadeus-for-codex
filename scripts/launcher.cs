// Amadeus.exe: starts the native Qt/OpenGL panel without a browser runtime.
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;

static class AmadeusLauncher
{
    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            if (args.Length == 1 && args[0] == "--panel-stdin")
            {
                string address = Console.In.ReadLine();
                Uri target;
                if (!Uri.TryCreate(address, UriKind.Absolute, out target) ||
                    target.Scheme != "http" || target.Host != "127.0.0.1" ||
                    target.Port < 1 || target.Port > 65535 ||
                    String.IsNullOrEmpty(target.Query))
                    throw new ArgumentException("Invalid local Amadeus daemon address.");

                string python = Path.Combine(root, ".native-venv", "Scripts", "pythonw.exe");
                string script = Path.Combine(root, "native", "panel.py");
                if (!File.Exists(python) || !File.Exists(script))
                    throw new FileNotFoundException("Native panel is not installed. Run 安装 Amadeus.cmd.");

                var start = new ProcessStartInfo();
                start.FileName = python;
                start.Arguments = "\"" + script + "\"";
                start.WorkingDirectory = root;
                start.UseShellExecute = false;
                start.RedirectStandardInput = true;
                start.CreateNoWindow = true;
                var child = Process.Start(start);
                child.StandardInput.WriteLine(address);
                child.StandardInput.Close();
                return 0;
            }

            string launcher = Path.Combine(root, "bin", "amadeus-panel.mjs");
            if (!File.Exists(launcher))
                throw new FileNotFoundException("Missing: " + launcher);
            var node = new ProcessStartInfo();
            node.FileName = "node";
            node.Arguments = "\"" + launcher + "\" --silent --welcome";
            node.WorkingDirectory = root;
            node.UseShellExecute = false;
            node.CreateNoWindow = true;
            Process.Start(node);
            return 0;
        }
        catch (Exception error)
        {
            MessageBox.Show(
                "Could not start Amadeus: " + error.Message +
                "\r\n\r\nRun 安装 Amadeus.cmd to install the native panel.",
                "Amadeus", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}

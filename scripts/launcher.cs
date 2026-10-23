// Amadeus.exe: local WinForms/WebView2 panel host.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

static class AmadeusLauncher
{
    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--panel-stdin")
            {
                Uri target;
                string address = Console.In.ReadLine();
                if (!Uri.TryCreate(address, UriKind.Absolute, out target) ||
                    target.Scheme != "http" || target.Host != "127.0.0.1" ||
                    target.AbsolutePath != "/amadeus/panel/index.html")
                    throw new ArgumentException("The panel address must be a local Amadeus address.");
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new PanelWindow(target));
                return 0;
            }

            string root = AppDomain.CurrentDomain.BaseDirectory;
            string script = Path.Combine(root, "bin", "amadeus-panel.mjs");
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
                "\r\n\r\nNode.js 22+ and Microsoft Edge WebView2 Runtime are required.",
                "Amadeus",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            return 1;
        }
    }

    sealed class PanelWindow : Form
    {
        readonly WebView2 view = new WebView2();
        readonly Uri target;

        public PanelWindow(Uri url)
        {
            target = url;
            Text = "AMADEUS";
            try
            {
                Icon = System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath)
                    ?? SystemIcons.Application;
            }
            catch
            {
                Icon = SystemIcons.Application;
            }
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(300, 520);
            MinimumSize = new Size(260, 420);
            BackColor = Color.FromArgb(26, 10, 18);
            view.Dock = DockStyle.Fill;
            Controls.Add(view);
            Shown += async (sender, args) =>
            {
                try
                {
                    string profile = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "Amadeus", "webview-profile");
                    Directory.CreateDirectory(profile);
                    CoreWebView2EnvironmentOptions options = new CoreWebView2EnvironmentOptions(
                        "--autoplay-policy=no-user-gesture-required");
                    CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(
                        null, profile, options);
                    await view.EnsureCoreWebView2Async(environment);
                    view.CoreWebView2.Settings.AreDevToolsEnabled = false;
                    view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                    view.Source = target;
                }
                catch (Exception error)
                {
                    MessageBox.Show(this, "Amadeus could not open its local window: " + error.Message +
                        "\r\nInstall Microsoft Edge WebView2 Runtime, then try again.",
                        "Amadeus", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    Close();
                }
            };
        }
    }
}

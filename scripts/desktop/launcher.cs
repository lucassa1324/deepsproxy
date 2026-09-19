/*
 * launcher.cs — Launcher do DeepsProxy (Windows).
 *
 * Compilado com o csc do .NET Framework (já presente no Windows) em um
 * win-exe sem console. Responsabilidades:
 *   - Garante instância única (mutex) e porta livre;
 *   - Sobe o servidor `node.exe dist/index.js` em segundo plano (sem janela);
 *   - Espera /health responder e abre a dashboard no navegador padrão;
 *   - Fica na bandeja com menu: Abrir Dashboard / Abrir Logs / Sair;
 *   - Ao sair, mata o node e o Chromium filho (taskkill /T).
 *
 * Público-alvo: usuário leigo — nenhum terminal, nenhum comando.
 */

using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;

namespace DeepsProxy
{
    static class Program
    {
        const string MUTEX_NAME = "Local\\DeepsProxy.DeepsProxy.SingleInstance";

        static string appDir;
        static int port = 3005;
        static Process nodeProc;
        static NotifyIcon tray;
        static bool quitting = false;
        static readonly object logLock = new object();
        static string logPath;

        [STAThread]
        static void Main()
        {
            bool createdNew;
            using (var mutex = new Mutex(true, MUTEX_NAME, out createdNew))
            {
                if (!createdNew)
                {
                    // Já está rodando (ou o servidor já está no ar): abre a dashboard.
                    WaitAndOpen(30);
                    return;
                }

                appDir = AppDomain.CurrentDomain.BaseDirectory;
                logPath = Path.Combine(appDir, "server.log");
                ReadEnvForPort();

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                SetupTray();
                StartServer();

                var t = new Thread(delegate() { WaitAndOpen(120); });
                t.IsBackground = true;
                t.Start();

                Application.Run();

                // (Application.Run retorna quando a bandeja é fechada / Stop).
            }
        }

        /* ---------------- .env / configuração ---------------- */

        static void ReadEnvForPort()
        {
            try
            {
                string envFile = Path.Combine(appDir, ".env");
                if (!File.Exists(envFile)) return;
                foreach (string rawLine in File.ReadAllLines(envFile))
                {
                    string line = rawLine.Trim();
                    if (line.Length == 0 || line.StartsWith("#")) continue;
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string key = line.Substring(0, eq).Trim();
                    string val = line.Substring(eq + 1).Trim();
                    if (val.Length >= 2 && val[0] == '"' && val[val.Length - 1] == '"')
                        val = val.Substring(1, val.Length - 2);

                    if (key == "PORT")
                    {
                        int p;
                        if (int.TryParse(val, out p) && p > 0) port = p;
                    }
                    else
                    {
                        // Repassa o valor ao node (herança de ambiente) sem sobrescrever
                        // variáveis já definidas pelo sistema/usuário.
                        if (Environment.GetEnvironmentVariable(key) == null)
                            Environment.SetEnvironmentVariable(key, val);
                    }
                }
            }
            catch
            {
                // .env ilegível não impede o launch (defaults acima).
            }
        }

        /* ---------------- servidor ---------------- */

        static void StartServer()
        {
            string node = Path.Combine(appDir, "node.exe");
            string entry = Path.Combine(appDir, "dist", "index.js");
            if (!File.Exists(node) || !File.Exists(entry))
            {
                string msg = node + " / " + entry + " nao encontrado.\nReinstale o DeepsProxy.";
                ShowBalloon("Erro ao iniciar", msg, ToolTipIcon.Error);
                return;
            }

            Environment.SetEnvironmentVariable("PLAYWRIGHT_BROWSERS_PATH", Path.Combine(appDir, "browsers"));
            Environment.SetEnvironmentVariable("NODE_ENV", "production");

            var psi = new ProcessStartInfo(node, "\"" + entry + "\"");
            psi.WorkingDirectory = appDir;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            try
            {
                nodeProc = Process.Start(psi);
            }
            catch (Exception ex)
            {
                ShowBalloon("Erro ao iniciar", "Falha ao iniciar o servidor: " + ex.Message, ToolTipIcon.Error);
                return;
            }

            nodeProc.OutputDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) WriteLog(e.Data); };
            nodeProc.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e) { if (e.Data != null) WriteLog(e.Data); };
            nodeProc.BeginOutputReadLine();
            nodeProc.BeginErrorReadLine();
            nodeProc.EnableRaisingEvents = true;
            nodeProc.Exited += delegate(object s, EventArgs e)
            {
                if (!quitting)
                {
                    ShowBalloon("DeepsProxy parou",
                        "O servidor encerrou inesperadamente. Use o menu da bandeja para reiniciar.",
                        ToolTipIcon.Warning);
                }
            };
        }

        static void StopServer()
        {
            if (nodeProc == null) return;
            try
            {
                // Kill-tree: encerra node + Chromium filhos (taskkill /PID /T /F).
                var psi = new ProcessStartInfo("taskkill", "/PID " + nodeProc.Id + " /T /F");
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                Process.Start(psi);
                nodeProc.WaitForExit(4000);
            }
            catch { }
            nodeProc = null;
        }

        static void RestartServer()
        {
            StopServer();
            Thread.Sleep(800);
            StartServer();
            var t = new Thread(delegate() { WaitAndOpen(120); });
            t.IsBackground = true;
            t.Start();
        }

        /* ---------------- dashboard ---------------- */

        static string DashboardUrl()
        {
            return "http://127.0.0.1:" + port;
        }

        static bool HealthOk()
        {
            try
            {
                HttpWebRequest req = (HttpWebRequest)WebRequest.Create(DashboardUrl() + "/health");
                req.Method = "GET";
                req.Timeout = 3000;
                req.ReadWriteTimeout = 3000;
                using (HttpWebResponse resp = (HttpWebResponse)req.GetResponse())
                {
                    using (var reader = new StreamReader(resp.GetResponseStream()))
                    {
                        string body = reader.ReadToEnd();
                        return resp.StatusCode == HttpStatusCode.OK
                            && body.IndexOf("ok", StringComparison.OrdinalIgnoreCase) >= 0;
                    }
                }
            }
            catch
            {
                return false;
            }
        }

        static void WaitAndOpen(int maxSeconds)
        {
            for (int i = 0; i < maxSeconds; i++)
            {
                if (HealthOk())
                {
                    OpenDashboard();
                    return;
                }
                Thread.Sleep(1000);
            }
            // Sem resposta: ainda assim tenta abrir (a página mostra o status).
            OpenDashboard();
        }

        static void OpenDashboard()
        {
            try
            {
                Process.Start(DashboardUrl());
            }
            catch
            {
                ShowBalloon("DeepsProxy", "Abra o navegador em " + DashboardUrl(), ToolTipIcon.Info);
            }
        }

        /* ---------------- bandeja ---------------- */

        static void SetupTray()
        {
            tray = new NotifyIcon();

            Icon icon = null;
            string iconPath = Path.Combine(appDir, "icon.ico");
            try { if (File.Exists(iconPath)) icon = new Icon(iconPath); } catch { icon = null; }
            tray.Icon = icon ?? SystemIcons.Application;

            tray.Text = "DeepsProxy";
            tray.Visible = true;

            var menu = new ContextMenu();
            menu.MenuItems.Add("Abrir Dashboard", delegate(object s, EventArgs e) { OpenDashboard(); });
            menu.MenuItems.Add("Reiniciar Servidor", delegate(object s, EventArgs e) { RestartServer(); });
            menu.MenuItems.Add("Abrir Logs", delegate(object s, EventArgs e) { OpenLogs(); });
            menu.MenuItems.Add("-");
            menu.MenuItems.Add("Sair", delegate(object s, EventArgs e)
            {
                quitting = true;
                tray.Visible = false;
                StopServer();
                Application.Exit();
            });
            tray.ContextMenu = menu;

            tray.DoubleClick += delegate(object s, EventArgs e) { OpenDashboard(); };
            tray.BalloonTipClicked += delegate(object s, EventArgs e) { OpenDashboard(); };
        }

        static void OpenLogs()
        {
            try
            {
                if (!File.Exists(logPath)) File.WriteAllText(logPath, "(sem log ainda)\r\n");
                Process.Start(new ProcessStartInfo(logPath) { UseShellExecute = true });
            }
            catch
            {
                ShowBalloon("DeepsProxy", "Não foi possível abrir o log.", ToolTipIcon.Warning);
            }
        }

        static void WriteLog(string line)
        {
            lock (logLock)
            {
                try
                {
                    File.AppendAllText(logPath, line + Environment.NewLine);
                }
                catch { }
            }
        }

        static void ShowBalloon(string title, string text, ToolTipIcon icon)
        {
            if (tray == null) return;
            tray.ShowBalloonTip(4000, title, text, icon);
        }
    }
}
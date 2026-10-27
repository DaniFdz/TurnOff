// Toast.cs — a real Windows notification, compiled on first run with the
// csc.exe that ships with .NET Framework (no installer, no extra modules).
//
// Uses the tray balloon API: Windows 10/11 route it to the notification area
// and the Action Center. Unlike a Windows.UI toast it needs no AppUserModelID
// registration, which an unpacked app does not have.
//
//   Toast.exe --title "TurnOff" --body "..." [--icon warn|info] [--seconds 8]

using System;
using System.Drawing;
using System.Windows.Forms;

namespace TurnOffToast
{
    public static class Program
    {
        [STAThread]
        public static int Main(string[] args)
        {
            string title = "TurnOff";
            string body = "";
            string icon = "info";
            int seconds = 8;

            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == "--title") title = args[i + 1];
                else if (args[i] == "--body") body = args[i + 1];
                else if (args[i] == "--icon") icon = args[i + 1];
                else if (args[i] == "--seconds") int.TryParse(args[i + 1], out seconds);
            }
            if (seconds < 3) seconds = 3;
            if (seconds > 30) seconds = 30;

            bool warn = icon == "warn";
            Application.EnableVisualStyles();

            using (NotifyIcon tray = new NotifyIcon())
            {
                tray.Icon = warn ? SystemIcons.Warning : SystemIcons.Information;
                tray.Text = title;
                tray.Visible = true;
                tray.BalloonTipTitle = title;
                tray.BalloonTipText = body;
                tray.BalloonTipIcon = warn ? ToolTipIcon.Warning : ToolTipIcon.Info;
                tray.ShowBalloonTip(seconds * 1000);

                // Keep the icon alive long enough for the balloon to appear; the
                // notification itself stays in the Action Center after we exit.
                Timer life = new Timer();
                life.Interval = seconds * 1000 + 1500;
                life.Tick += delegate
                {
                    life.Stop();
                    tray.Visible = false;
                    Application.Exit();
                };
                life.Start();
                Application.Run();
            }
            return 0;
        }
    }
}

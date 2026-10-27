// NightAudio.cs — TurnOff night mode for Windows, compiled on first run with the
// C# compiler that ships with .NET Framework (csc.exe), so nothing extra is installed.
//
// Reads the peak of whatever is playing on the default output (Core Audio
// IAudioMeterInformation, measured BEFORE the volume slider) ~60 times a second
// and rides the endpoint master volume like a compressor: instant cut when a
// peak crosses the ceiling, hold, then a slow release back to the volume the
// user chose. It never raises the volume above that choice.
//
// Protocol, one line per message:
//   stdin : "on <ceilingDb> <attackMs> <releaseMs> <holdMs> <maxCutDb>" | "off" | "quit"
//   stdout: JSON objects: ready | device | level | state | cmd | recovered | orphaned | error | bye
// The volume is given back when stdin closes, when TurnOff's process disappears
// (--parent), and after a hard kill on the next start (--state file).

using System;
using System.IO;
using System.Threading;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Collections.Concurrent;

namespace TurnOffAudio {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  internal class MMDeviceEnumeratorCo { }

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  }

  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioEndpointVolume {
    [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
    [PreserveSig] int GetChannelCount(out uint count);
    [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid context);
    [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
    [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
    [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
    [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid context);
    [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
    [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
    [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
    [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
    [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
    [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
    [PreserveSig] int VolumeStepUp(ref Guid context);
    [PreserveSig] int VolumeStepDown(ref Guid context);
    [PreserveSig] int QueryHardwareSupport(out uint mask);
    [PreserveSig] int GetVolumeRange(out float minDb, out float maxDb, out float incrementDb);
  }

  [ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioMeterInformation {
    [PreserveSig] int GetPeakValue(out float peak);
  }

  public static class Engine {
    static IAudioEndpointVolume vol;
    static IAudioMeterInformation meter;
    static string devId;
    static float minDb = -65f, maxDb = 0f;
    static Guid ctx = new Guid("6F0A4C2E-2B1D-4D0A-9C6E-1E7F0A7D5B11");
    static ConcurrentQueue<string> cmds = new ConcurrentQueue<string>();
    static volatile bool eof;
    static string stateFile;

    static bool enabled;
    static double ceilingDb = -14, attackMs = 5, releaseMs = 1500, holdMs = 400, maxCutDb = 24;
    static double baselineDb = double.NaN, gainDb = 0, lastSetDb = double.NaN;
    static long holdUntil;

    static void Emit(string json) { Console.Out.WriteLine(json); Console.Out.Flush(); }
    static string F(double v) {
      if (double.IsNaN(v) || double.IsInfinity(v)) return "null";
      return v.ToString("0.###", CultureInfo.InvariantCulture);
    }
    static string Esc(string s) { return s == null ? "" : s.Replace("\\", "\\\\").Replace("\"", "\\\""); }
    static double P(string s, double fallback) {
      double v;
      return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out v) ? v : fallback;
    }

    static void SetVolume(double db) {
      float target = (float)Math.Max(minDb, Math.Min(maxDb, db));
      vol.SetMasterVolumeLevel(target, ref ctx);
      float back;
      // Hardware volume is stepped: remember what really got applied, or the
      // next tick mistakes the rounding for the user moving the slider.
      lastSetDb = vol.GetMasterVolumeLevel(out back) == 0 ? back : target;
    }

    static bool Acquire(bool force) {
      try {
        IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCo());
        IMMDevice dev;
        if (en.GetDefaultAudioEndpoint(0, 0, out dev) != 0 || dev == null) return false;
        string id;
        dev.GetId(out id);
        if (!force && id == devId && vol != null) return true;
        // Leaving a device while it is ducked: hand its volume back first.
        if (vol != null && enabled && !double.IsNaN(baselineDb)) {
          try { SetVolume(baselineDb); } catch { }
        }
        object o;
        Guid gv = typeof(IAudioEndpointVolume).GUID;
        if (dev.Activate(ref gv, 23, IntPtr.Zero, out o) != 0) return false;
        IAudioEndpointVolume v = (IAudioEndpointVolume)o;
        Guid gm = typeof(IAudioMeterInformation).GUID;
        if (dev.Activate(ref gm, 23, IntPtr.Zero, out o) != 0) return false;
        meter = (IAudioMeterInformation)o;
        vol = v;
        float mn, mx, inc;
        if (vol.GetVolumeRange(out mn, out mx, out inc) == 0) { minDb = mn; maxDb = mx; }
        devId = id;
        baselineDb = double.NaN; gainDb = 0; lastSetDb = double.NaN;
        Emit("{\"t\":\"device\",\"id\":\"" + Esc(id) + "\",\"min\":" + F(minDb) + ",\"max\":" + F(maxDb) + "}");
        return true;
      } catch (Exception e) {
        Emit("{\"t\":\"error\",\"msg\":\"" + Esc(e.Message) + "\"}");
        vol = null; meter = null;
        return false;
      }
    }

    static void SaveBaseline() {
      if (string.IsNullOrEmpty(stateFile) || double.IsNaN(baselineDb)) return;
      try { File.WriteAllText(stateFile, baselineDb.ToString("R", CultureInfo.InvariantCulture) + "|" + devId); } catch { }
    }

    static void Restore() {
      if (vol != null && !double.IsNaN(baselineDb)) {
        try { SetVolume(baselineDb); } catch { }
      }
      baselineDb = double.NaN; gainDb = 0; lastSetDb = double.NaN;
      if (!string.IsNullOrEmpty(stateFile)) { try { File.Delete(stateFile); } catch { } }
    }

    static void RecoverFromHardKill() {
      if (string.IsNullOrEmpty(stateFile) || !File.Exists(stateFile)) return;
      try {
        string[] p = File.ReadAllText(stateFile).Split('|');
        double b = double.Parse(p[0], CultureInfo.InvariantCulture);
        float cur;
        // Only undo a duck we left behind: never make it louder than the user had it.
        if (vol != null && p.Length > 1 && p[1] == devId && vol.GetMasterVolumeLevel(out cur) == 0 && cur < b - 0.5) {
          SetVolume(b);
          Emit("{\"t\":\"recovered\",\"base\":" + F(b) + ",\"was\":" + F(cur) + "}");
        }
      } catch { }
      try { File.Delete(stateFile); } catch { }
    }

    static void Handle(string line) {
      string[] a = line.Trim().Split(' ');
      if (a.Length == 0 || a[0].Length == 0) return;
      Emit("{\"t\":\"cmd\",\"line\":\"" + Esc(line.Trim()) + "\"}");
      if (a[0] == "on") {
        if (a.Length > 1) ceilingDb = P(a[1], ceilingDb);
        if (a.Length > 2) attackMs = P(a[2], attackMs);
        if (a.Length > 3) releaseMs = Math.Max(1, P(a[3], releaseMs));
        if (a.Length > 4) holdMs = P(a[4], holdMs);
        if (a.Length > 5) maxCutDb = P(a[5], maxCutDb);
        if (!enabled) { enabled = true; baselineDb = double.NaN; gainDb = 0; }
        Emit("{\"t\":\"state\",\"on\":true,\"ceiling\":" + F(ceilingDb) + "}");
      } else if (a[0] == "off") {
        if (enabled) Restore();
        enabled = false;
        Emit("{\"t\":\"state\",\"on\":false}");
      } else if (a[0] == "quit") {
        eof = true;
      }
    }

    static bool ParentGone(int pid) {
      if (pid <= 0) return false;
      try { Process p = Process.GetProcessById(pid); return p.HasExited; } catch { return true; }
    }

    public static int Main(string[] args) {
      string state = "";
      int parent = 0;
      for (int i = 0; i + 1 < args.Length; i++) {
        if (args[i] == "--state") state = args[i + 1];
        if (args[i] == "--parent") int.TryParse(args[i + 1], out parent);
      }
      Run(state, parent);
      return 0;
    }

    public static void Run(string state, int parentPid) {
      stateFile = state;
      Thread reader = new Thread(delegate () {
        try {
          StreamReader input = new StreamReader(Console.OpenStandardInput());
          string l;
          while ((l = input.ReadLine()) != null) cmds.Enqueue(l);
        } catch { }
        eof = true;
      });
      reader.IsBackground = true;
      reader.Start();

      Acquire(true);
      RecoverFromHardKill();
      Emit("{\"t\":\"ready\"}");

      Stopwatch sw = Stopwatch.StartNew();
      long lastTick = 0, lastReport = 0, lastProbe = 0;
      while (!eof) {
        string c;
        while (cmds.TryDequeue(out c)) Handle(c);
        if (eof) break;
        long now = sw.ElapsedMilliseconds;
        if (now - lastProbe > 2000) {
          lastProbe = now;
          // Second safety net: if TurnOff is gone, give the volume back and leave.
          if (ParentGone(parentPid)) { Emit("{\"t\":\"orphaned\"}"); break; }
          Acquire(false);
        }
        double dt = Math.Max(1, now - lastTick);
        lastTick = now;

        float peak = 0, cur = 0;
        bool ok = vol != null && meter != null;
        if (ok) {
          try {
            if (meter.GetPeakValue(out peak) != 0 || vol.GetMasterVolumeLevel(out cur) != 0) ok = false;
          } catch { ok = false; vol = null; meter = null; }
        }
        double peakDb = peak > 0.00001 ? 20 * Math.Log10(peak) : double.NegativeInfinity;

        if (ok && enabled) {
          if (double.IsNaN(baselineDb)) { baselineDb = cur; lastSetDb = cur; SaveBaseline(); }
          else if (Math.Abs(cur - lastSetDb) > 0.4) { baselineDb = cur - gainDb; lastSetDb = cur; SaveBaseline(); }

          double wanted = peakDb > ceilingDb ? ceilingDb - peakDb : 0;
          if (wanted < -maxCutDb) wanted = -maxCutDb;
          if (wanted < gainDb) {
            gainDb = attackMs <= 0 ? wanted : wanted + (gainDb - wanted) * Math.Exp(-dt / attackMs);
            holdUntil = now + (long)holdMs;
          } else if (now >= holdUntil) {
            gainDb = wanted + (gainDb - wanted) * Math.Exp(-dt / releaseMs);
            if (gainDb > -0.05) gainDb = 0;
          }
          double target = Math.Max(minDb, Math.Min(maxDb, baselineDb + gainDb));
          if (Math.Abs(target - cur) > 0.25) {
            try { SetVolume(target); } catch { }
          }
        }

        if (now - lastReport >= 200) {
          lastReport = now;
          Emit("{\"t\":\"level\",\"ok\":" + (ok ? "true" : "false") + ",\"peak\":" + F(peak) + ",\"vol\":" + F(cur)
            + ",\"gain\":" + F(enabled ? gainDb : 0) + ",\"base\":" + F(baselineDb) + ",\"on\":" + (enabled ? "true" : "false") + "}");
        }
        Thread.Sleep(enabled ? 15 : 100);
      }
      if (enabled) Restore();
      Emit("{\"t\":\"bye\"}");
    }
  }
}

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class ChromiumWindowIcon
{
    private const uint SetIcon = 0x0080;
    private const uint AbortIfHung = 0x0002;
    private const uint LoadFromFile = 0x0010;
    private static readonly Guid AppModelFormat = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    private delegate bool EnumWindow(IntPtr window, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out int processId);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder name, int size);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int index);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr icon);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr parameter, IntPtr value,
        uint flags, uint timeout, out IntPtr result);

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid format;
        public uint id;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyValue
    {
        public ushort type, reserved1, reserved2, reserved3;
        public IntPtr text, padding;
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropertyValue value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropertyValue value);
        [PreserveSig] int Commit();
    }

    private static void SetProperty(IPropertyStore store, uint id, string text)
    {
        var key = new PropertyKey { format = AppModelFormat, id = id };
        var value = new PropertyValue { type = 31, text = Marshal.StringToCoTaskMemUni(text) };
        try { Marshal.ThrowExceptionForHR(store.SetValue(ref key, ref value)); }
        finally { Marshal.FreeCoTaskMem(value.text); }
    }

    private static void SetTaskbarBrand(IntPtr window, string appId, string relaunch, string iconPath, string displayName)
    {
        if (String.IsNullOrEmpty(relaunch)) return;
        Guid iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        if (SHGetPropertyStoreForWindow(window, ref iid, out store) < 0 || store == null) return;
        try
        {
            SetProperty(store, 2, relaunch);
            SetProperty(store, 3, iconPath + ",0");
            SetProperty(store, 4, displayName);
            SetProperty(store, 5, appId);
        }
        catch (COMException) { } // The window can close during the update.
        finally { Marshal.ReleaseComObject(store); }
    }

    [STAThread]
    public static void Main(string[] args)
    {
        int pid;
        if (args.Length != 5 || !Int32.TryParse(args[0], out pid) || !File.Exists(args[1])) return;
        try
        {
            using (Process browser = Process.GetProcessById(pid))
            {
                Watch(browser, args[1], args[2], args[3], args[4]);
            }
        }
        catch (ArgumentException) { } // The browser exited before the watcher started.
        catch (InvalidOperationException) { } // The browser exited while attaching.
    }

    private static void Watch(Process browser, string iconPath, string appId, string relaunch, string displayName)
    {
        int pid = browser.Id;
        IntPtr big = LoadImage(IntPtr.Zero, iconPath, 1, GetSystemMetrics(11), GetSystemMetrics(12), LoadFromFile);
        IntPtr small = LoadImage(IntPtr.Zero, iconPath, 1, GetSystemMetrics(49), GetSystemMetrics(50), LoadFromFile);
        try
        {
            if (big == IntPtr.Zero && small == IntPtr.Zero) return;
            var attempts = new Dictionary<IntPtr, int>();
            var name = new StringBuilder(64);
            do
            {
                var visible = new Dictionary<IntPtr, int>();
                EnumWindows((window, unused) =>
                {
                    int owner;
                    GetWindowThreadProcessId(window, out owner);
                    if (owner != pid || !IsWindowVisible(window)) return true;
                    if (GetClassName(window, name, name.Capacity) == 0 || name.ToString() != "Chrome_WidgetWin_1") return true;

                    int attempt;
                    attempts.TryGetValue(window, out attempt);
                    if (attempt < 2)
                    {
                        IntPtr previous;
                        if (big != IntPtr.Zero) SendMessageTimeout(window, SetIcon, new IntPtr(1), big, AbortIfHung, 100, out previous);
                        if (small != IntPtr.Zero) SendMessageTimeout(window, SetIcon, IntPtr.Zero, small, AbortIfHung, 100, out previous);
                        SetTaskbarBrand(window, appId, relaunch, iconPath, displayName);
                        attempt++;
                    }
                    visible[window] = attempt;
                    return true;
                }, IntPtr.Zero);
                attempts = visible;
            }
            while (!browser.WaitForExit(500));
        }
        finally
        {
            if (big != IntPtr.Zero) DestroyIcon(big);
            if (small != IntPtr.Zero) DestroyIcon(small);
        }
    }
}

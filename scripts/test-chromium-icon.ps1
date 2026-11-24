param(
    [int]$BrowserPid,
    [string]$IconPath,
    [int]$ExpectedWindows = 1
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;

public static class ChromiumIconProbe
{
    private delegate bool Callback(IntPtr window, IntPtr unused);
    [DllImport("user32.dll")] private static extern bool EnumWindows(Callback callback, IntPtr unused);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out int pid);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern bool DestroyIcon(IntPtr icon);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr parameter, IntPtr value,
        uint flags, uint timeout, out IntPtr result);
    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHGetPropertyStoreForWindow(IntPtr window, ref Guid iid,
        [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    [DllImport("ole32.dll")] private static extern int PropVariantClear(ref Property value);

    [StructLayout(LayoutKind.Sequential)] private struct Key { public Guid format; public uint id; }
    [StructLayout(LayoutKind.Sequential)] private struct Property
    {
        public ushort type, reserved1, reserved2, reserved3;
        public IntPtr text, padding;
    }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out Key key);
        [PreserveSig] int GetValue(ref Key key, out Property value);
    }

    private static string Read(IPropertyStore store, uint id)
    {
        var key = new Key { format = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), id = id };
        Property value;
        if (store.GetValue(ref key, out value) < 0) return null;
        try { return value.type == 31 ? Marshal.PtrToStringUni(value.text) : null; }
        finally { PropVariantClear(ref value); }
    }

    private static bool MatchesTaskbar(IntPtr window, string iconPath)
    {
        Guid iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        if (SHGetPropertyStoreForWindow(window, ref iid, out store) < 0 || store == null) return false;
        try
        {
            var id = Read(store, 5);
            var command = Read(store, 2);
            return id != null && id.StartsWith("DTFingerprintBrowser.Chromium.", StringComparison.Ordinal) &&
                Read(store, 3) == iconPath + ",0" && command != null && command.Contains("\"chromium\"");
        }
        finally { Marshal.ReleaseComObject(store); }
    }

    private static bool MatchesWindowIcon(IntPtr window, byte size, IntPtr expected)
    {
        IntPtr actual;
        if (SendMessageTimeout(window, 0x007F, new IntPtr(size), IntPtr.Zero, 2, 150, out actual) == IntPtr.Zero
            || actual == IntPtr.Zero) return false;
        using (Icon want = Icon.FromHandle(expected))
        using (Icon have = Icon.FromHandle(actual))
        using (Bitmap wanted = want.ToBitmap())
        using (Bitmap current = have.ToBitmap())
        {
            if (wanted.Size != current.Size) return false;
            for (int y = 0; y < wanted.Height; y++)
                for (int x = 0; x < wanted.Width; x++)
                    if (wanted.GetPixel(x, y) != current.GetPixel(x, y)) return false;
            return true;
        }
    }

    public static int CountBrandedWindows(int pid, string iconPath)
    {
        IntPtr big = LoadImage(IntPtr.Zero, iconPath, 1, GetSystemMetrics(11), GetSystemMetrics(12), 16);
        IntPtr small = LoadImage(IntPtr.Zero, iconPath, 1, GetSystemMetrics(49), GetSystemMetrics(50), 16);
        if (big == IntPtr.Zero || small == IntPtr.Zero) throw new InvalidOperationException("Cannot load test icon");
        int count = 0;
        try
        {
            EnumWindows((window, unused) =>
            {
                int owner;
                GetWindowThreadProcessId(window, out owner);
                if (owner != pid || !IsWindowVisible(window)) return true;
                var name = new StringBuilder(64);
                if (GetClassName(window, name, name.Capacity) == 0 || name.ToString() != "Chrome_WidgetWin_1") return true;
                if (MatchesWindowIcon(window, 1, big) && MatchesWindowIcon(window, 0, small) && MatchesTaskbar(window, iconPath))
                    count++;
                return true;
            }, IntPtr.Zero);
            return count;
        }
        finally
        {
            DestroyIcon(big);
            DestroyIcon(small);
        }
    }
}
'@ -ReferencedAssemblies 'System.Drawing.dll'

$until = [DateTime]::UtcNow.AddSeconds(12)
do {
    $count = [ChromiumIconProbe]::CountBrandedWindows($BrowserPid, $IconPath)
    if ($count -ge $ExpectedWindows) {
        Write-Output "PASS DT window, Alt+Tab and taskbar properties on $count Chromium windows"
        exit 0
    }
    Start-Sleep -Milliseconds 300
} until ([DateTime]::UtcNow -ge $until)
throw "Expected $ExpectedWindows branded Chromium windows, found $count."

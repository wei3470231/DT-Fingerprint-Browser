using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class RuntimeCoreInstaller
{
    private const string Release = "https://github.com/wei3470231/DT-Fingerprint-Browser/releases/download/core/";

    public sealed class Asset
    {
        public string archive { get; set; }
        public string executable { get; set; }
        public long size { get; set; }
        public string sha256 { get; set; }
    }

    private static string Hex(byte[] bytes)
    {
        return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
    }

    private static string DiskPath(string path, int extra = 0)
    {
        if (path.Length + extra < 240 || path.StartsWith(@"\\?\", StringComparison.Ordinal)) return path;
        return path.StartsWith(@"\\", StringComparison.Ordinal)
            ? @"\\?\UNC\" + path.Substring(2)
            : @"\\?\" + path;
    }

    private static void MoveDirectory(string from, string to)
    {
        int extra = from.Length >= 240 || to.Length >= 240 || from.StartsWith(@"\\?\", StringComparison.Ordinal) ? 240 : 0;
        Directory.Move(DiskPath(from, extra), DiskPath(to, extra));
    }

    private static bool Verified(string path, Asset asset)
    {
        path = DiskPath(path);
        if (!File.Exists(path) || new FileInfo(path).Length != asset.size) return false;
        using (SHA256 sha = SHA256.Create())
        using (FileStream input = File.OpenRead(path)) return Hex(sha.ComputeHash(input)) == asset.sha256;
    }

    private static void Report(string phase, Asset asset, long bytes = 0)
    {
        Console.WriteLine("DT_CORE_PROGRESS {0} {1} {2}", phase, bytes, asset.size);
    }

    private static string WritableCores(string root, string adjacent, Asset asset)
    {
        try
        {
            Directory.CreateDirectory(DiskPath(adjacent));
            string probe = DiskPath(Path.Combine(adjacent, ".write-" + Guid.NewGuid().ToString("N").Substring(0, 12)));
            using (File.Open(probe, FileMode.CreateNew, FileAccess.Write, FileShare.None)) { }
            File.Delete(probe);
            return adjacent;
        }
        catch (UnauthorizedAccessException)
        {
            // An elevated process must never load a browser from its unelevated user's writable cache.
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
                if (new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) throw;

            string local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (String.IsNullOrEmpty(local)) throw;
            string installKey;
            using (SHA256 sha = SHA256.Create())
                installKey = Hex(sha.ComputeHash(Encoding.UTF8.GetBytes(root.ToUpperInvariant())));
            string cache = Path.Combine(local, "DT-Fingerprint-Browser", "runtime-cache", installKey.Substring(0, 24), asset.sha256.Substring(0, 24));
            Directory.CreateDirectory(DiskPath(cache));
            return cache;
        }
    }

    private static FileStream TakeLock(string file)
    {
        var until = DateTime.UtcNow.AddMinutes(25);
        while (true)
        {
            try { return File.Open(DiskPath(file), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None); }
            catch (IOException error)
            {
                int code = error.HResult & 0xffff;
                if ((code != 32 && code != 33) || DateTime.UtcNow >= until) throw;
                Thread.Sleep(300);
            }
        }
    }

    private static HttpWebResponse OpenDownload(Uri url)
    {
        for (int redirects = 0; redirects <= 8; redirects++)
        {
            if (url.Scheme != Uri.UriSchemeHttps) throw new IOException("GitHub redirected the download outside HTTPS.");
            var request = (HttpWebRequest)WebRequest.Create(url);
            request.AllowAutoRedirect = false;
            request.UserAgent = "DT-Fingerprint-Browser/3.0";
            request.Timeout = 45000;
            request.ReadWriteTimeout = 45000;
            HttpWebResponse response = (HttpWebResponse)request.GetResponse();
            int status = (int)response.StatusCode;
            if (status == 200) return response;
            using (response)
            {
                string next = response.Headers[HttpResponseHeader.Location];
                if (status < 300 || status >= 400 || String.IsNullOrEmpty(next))
                    throw new IOException("GitHub download returned HTTP " + status + ".");
                url = new Uri(url, next);
            }
        }
        throw new IOException("GitHub redirected the download too many times.");
    }

    private static void Download(Asset asset, string file)
    {
        ServicePointManager.SecurityProtocol |= SecurityProtocolType.Tls12;
        for (int attempt = 0; attempt < 2; attempt++)
        {
            try
            {
                Report("download", asset);
                using (HttpWebResponse response = OpenDownload(new Uri(Release + asset.archive)))
                using (Stream input = response.GetResponseStream())
                using (FileStream output = File.Create(DiskPath(file)))
                {
                    var timer = Stopwatch.StartNew();
                    byte[] buffer = new byte[128 * 1024];
                    int count;
                    long bytes = 0;
                    while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        bytes += count;
                        if (bytes > asset.size) throw new IOException("GitHub returned a larger file than expected.");
                        output.Write(buffer, 0, count);
                        if (timer.ElapsedMilliseconds >= 350)
                        {
                            Report("download", asset, bytes);
                            timer.Restart();
                        }
                    }
                    Report("download", asset, bytes);
                }
                return;
            }
            catch (WebException error)
            {
                if (attempt == 1) throw new IOException("GitHub download failed for " + asset.archive + ": " + error.Message, error);
            }
            catch (IOException error)
            {
                if (attempt == 1) throw new IOException("Cannot save " + asset.archive + ": " + error.Message, error);
            }
            Thread.Sleep(800);
        }
    }

    private static void ExtractRuntime(string archive, string destination, Asset asset)
    {
        using (FileStream file = File.OpenRead(DiskPath(archive)))
        using (var zip = new ZipArchive(file, ZipArchiveMode.Read))
        {
            string prefix = null;
            foreach (ZipArchiveEntry entry in zip.Entries)
            {
                string name = entry.FullName.Replace('\\', '/');
                string[] parts = name.Split('/');
                if (parts.Length > 2 || parts[parts.Length - 1] != asset.executable) continue;
                if (prefix != null) throw new IOException("Ambiguous runtime archive layout.");
                prefix = parts.Length == 2 ? parts[0] + "/" : "";
            }
            if (prefix == null) throw new IOException("The verified archive did not contain " + asset.executable + ".");

            // Flatten the verified archive's wrapper folder to keep installed paths short.
            string root = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;
            foreach (ZipArchiveEntry entry in zip.Entries)
            {
                string name = entry.FullName.Replace('\\', '/');
                if (!name.StartsWith(prefix, StringComparison.Ordinal) || name.Length == prefix.Length) continue;
                string relative = name.Substring(prefix.Length).Replace('/', Path.DirectorySeparatorChar);
                string target = Path.GetFullPath(Path.Combine(root, relative));
                if (relative.Contains(":") || !target.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                    throw new IOException("Runtime archive entry escapes its extraction directory.");
                if (name.EndsWith("/", StringComparison.Ordinal))
                {
                    Directory.CreateDirectory(DiskPath(target.TrimEnd(Path.DirectorySeparatorChar)));
                    continue;
                }
                Directory.CreateDirectory(DiskPath(Path.GetDirectoryName(target)));
                using (Stream input = entry.Open())
                using (FileStream output = File.Open(DiskPath(target), FileMode.CreateNew, FileAccess.Write, FileShare.None))
                    input.CopyTo(output);
            }
        }
    }

    public static string Install(string root, string core)
    {
        if (core != "chromium" && core != "electron") throw new ArgumentException("Unknown browser core.");
        root = new DirectoryInfo(root).FullName;
        string manifest = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "cores.json");
        Asset asset = new JavaScriptSerializer().Deserialize<Dictionary<string, Asset>>(File.ReadAllText(manifest))[core];
        string adjacent = Path.Combine(root, "runtime", "cores");
        string existing = Path.Combine(adjacent, core, asset.executable);
        if (File.Exists(DiskPath(existing))) return existing;
        Report("checking", asset);
        string cores = WritableCores(root, adjacent, asset);
        string destination = Path.Combine(cores, core);
        string executable = Path.Combine(destination, asset.executable);
        using (TakeLock(Path.Combine(cores, core + ".lock")))
        {
            if (File.Exists(DiskPath(executable))) return executable;
            string stage = Path.Combine(cores, ".dt-" + Guid.NewGuid().ToString("N").Substring(0, 12));
            Directory.CreateDirectory(DiskPath(stage));
            try
            {
                string archive = Path.Combine(stage, asset.archive);
                string local = Path.Combine(root, asset.archive);
                if (File.Exists(DiskPath(local))) File.Copy(DiskPath(local), DiskPath(archive));
                if (!Verified(archive, asset)) Download(asset, archive);
                Report("checking", asset);
                if (!Verified(archive, asset)) throw new IOException("SHA-256 verification failed for " + asset.archive + ".");
                Report("extracting", asset);
                string runtime = Path.Combine(stage, "r");
                ExtractRuntime(archive, runtime, asset);
                if (Directory.Exists(DiskPath(destination)))
                    MoveDirectory(destination, Path.Combine(cores, ".incomplete-" + Guid.NewGuid().ToString("N").Substring(0, 12)));
                MoveDirectory(runtime, destination);
                return executable;
            }
            finally
            {
                try { Directory.Delete(DiskPath(stage, 110), true); }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
        }
    }
}

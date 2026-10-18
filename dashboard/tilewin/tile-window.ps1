# One dashboard tile in a window of its own, without a frame: no title bar,
# Windows 11's round corners, moved by dragging the tile anywhere, resized at
# its edge. The tile runs in Edge's engine (WebView2); the page asks this host
# to move the window ("drag"), to keep it on top ("pin") or to close it.
# Where it stands is kept in ~/.claude/live-code-tiles.json, by tile: moved,
# resized or pinned, it is written; closed with its ✕ it is taken out, so the
# dashboard opens again just the windows that were open, where they were.
#   tile-window.ps1 -Key cost -Url http://127.0.0.1:4477/app?tile=cost -X 100 -Y 100 -W 380 -H 240 [-Top]
param([Parameter(Mandatory)][string]$Key, [Parameter(Mandatory)][string]$Url, [int]$X = 200, [int]$Y = 200, [int]$W = 380, [int]$H = 240, [switch]$Top, [ValidateSet('mini', 'detail')][string]$View = 'mini')

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# one window per tile, however often it is asked for
$created = $false
$script:mutex = [System.Threading.Mutex]::new($true, "LiveCodeTile-$Key-$View", [ref]$created)
if (-not $created) { exit 0 }
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
# WebView2's three files: beside this script, or where the setup fetched them (webview2.mjs)
$lib = @($here, (Join-Path $env:LOCALAPPDATA 'live-code-dashboard\webview2')) | Where-Object { Test-Path (Join-Path $_ 'Microsoft.Web.WebView2.Core.dll') } | Select-Object -First 1
if (-not $lib) { exit 3 }
$core = [Reflection.Assembly]::LoadFrom("$lib\Microsoft.Web.WebView2.Core.dll")
$forms = [Reflection.Assembly]::LoadFrom("$lib\Microsoft.Web.WebView2.WinForms.dll")

Add-Type -AssemblyName System.Web.Extensions
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing, System.Web.Extensions, $core.Location, $forms.Location -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

public class TileWindow : Form {
  [DllImport("user32.dll")] static extern bool ReleaseCapture();
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr w, IntPtr l);
  [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int value, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  // a taskbar group of its own, not PowerShell's
  [DllImport("shell32.dll")] public static extern int SetCurrentProcessExplicitAppUserModelID([MarshalAs(UnmanagedType.LPWStr)] string id);

  const int EDGE = 6; // the frame's grip, inside the window
  readonly WebView2 web = new WebView2();
  readonly string url, dataDir, loaderDir, key, store, view;
  bool closedByHand;

  public TileWindow(string key, string url, string dataDir, string loaderDir, string store, Rectangle bounds, bool top, string view, Icon icon) {
    // minimal and detailed are windows apart: "cost", "cost@detail"
    this.key = view == "detail" ? key + "@detail" : key;
    this.view = view;
    if (icon != null) Icon = icon;
    this.url = url;
    this.dataDir = dataDir;
    this.loaderDir = loaderDir;
    this.store = store;
    FormBorderStyle = FormBorderStyle.None;
    StartPosition = FormStartPosition.Manual;
    // where it was, on the screen it was on; a screen gone: the main one
    bool seen = false;
    foreach (Screen s in Screen.AllScreens) if (s.WorkingArea.IntersectsWith(new Rectangle(bounds.X + 20, bounds.Y + 20, 40, 40))) seen = true;
    if (!seen) bounds.Location = new Point(Screen.PrimaryScreen.WorkingArea.X + 80, Screen.PrimaryScreen.WorkingArea.Y + 80);
    Bounds = bounds;
    TopMost = top;
    ResizeEnd += (s, e) => Save();
    FormClosing += (s, e) => { if (closedByHand) Forget(); };
    MinimumSize = new Size(160, 100);
    BackColor = Color.FromArgb(10, 11, 17);
    Padding = new Padding(EDGE);
    Text = "Live Code";
    web.Dock = DockStyle.Fill;
    web.DefaultBackgroundColor = Color.FromArgb(10, 11, 17);
    Controls.Add(web);
    Load += async (s, e) => {
      CoreWebView2Environment.SetLoaderDllFolderPath(loaderDir);
      var env = await CoreWebView2Environment.CreateAsync(null, dataDir);
      await web.EnsureCoreWebView2Async(env);
      web.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
      web.CoreWebView2.Settings.IsStatusBarEnabled = false;
      web.CoreWebView2.DocumentTitleChanged += (a, b) => { Text = web.CoreWebView2.DocumentTitle; };
      web.CoreWebView2.WebMessageReceived += OnMessage;
      web.Source = new Uri(url);
    };
  }

  void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e) {
    string m = e.TryGetWebMessageAsString();
    if (m == "drag") { ReleaseCapture(); SendMessage(Handle, 0xA1, (IntPtr)2, IntPtr.Zero); Save(); }
    else if (m == "pin") { TopMost = !TopMost; Save(); web.CoreWebView2.PostWebMessageAsString(TopMost ? "pinned" : "unpinned"); }
    else if (m == "ready") { web.CoreWebView2.PostWebMessageAsString(TopMost ? "pinned" : "unpinned"); }
    else if (m == "close") { closedByHand = true; Close(); }
  }

  // ~/.claude/live-code-tiles.json: { "<tile>": { x, y, w, h, top } } for each open window
  Dictionary<string, object> Read() {
    try { return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(store)) ?? new Dictionary<string, object>(); }
    catch { return new Dictionary<string, object>(); }
  }
  void Write(Dictionary<string, object> all) {
    try { string tmp = store + "." + System.Diagnostics.Process.GetCurrentProcess().Id + ".tmp"; File.WriteAllText(tmp, new JavaScriptSerializer().Serialize(all)); if (File.Exists(store)) File.Delete(store); File.Move(tmp, store); } catch { }
  }
  // every tile window writes the one file: one at a time, each reading what the last wrote
  static readonly System.Threading.Mutex storeLock = new System.Threading.Mutex(false, "LiveCodeTilesStore");
  void Change(Action<Dictionary<string, object>> change) {
    bool held = false;
    try { held = storeLock.WaitOne(3000); } catch (System.Threading.AbandonedMutexException) { held = true; }
    try { var all = Read(); change(all); Write(all); } finally { if (held) storeLock.ReleaseMutex(); }
  }
  void Save() {
    if (WindowState != FormWindowState.Normal) return;
    var entry = new Dictionary<string, object> { { "x", Left }, { "y", Top }, { "w", Width }, { "h", Height }, { "top", TopMost }, { "view", view } };
    Change(all => { all[key] = entry; });
  }
  void Forget() { Change(all => { all.Remove(key); }); }
  // started by the dashboard's server in the background, Windows would keep it
  // behind the window just clicked: on top for a moment brings it forward
  protected override void OnShown(EventArgs e) {
    base.OnShown(e);
    if (!TopMost) { TopMost = true; TopMost = false; }
    Activate();
    Save();
  }

  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    int round = 2; // DWMWCP_ROUND
    DwmSetWindowAttribute(Handle, 33, ref round, 4);
  }

  // the edge, a few pixels inside the window, resizes it
  protected override void WndProc(ref Message m) {
    if (m.Msg == 0x84) { // WM_NCHITTEST
      base.WndProc(ref m);
      Point p = PointToClient(new Point(unchecked((short)(long)m.LParam), unchecked((short)((long)m.LParam >> 16))));
      bool l = p.X < EDGE, r = p.X >= ClientSize.Width - EDGE, t = p.Y < EDGE, b = p.Y >= ClientSize.Height - EDGE;
      if (t && l) m.Result = (IntPtr)13; else if (t && r) m.Result = (IntPtr)14;
      else if (b && l) m.Result = (IntPtr)16; else if (b && r) m.Result = (IntPtr)17;
      else if (l) m.Result = (IntPtr)10; else if (r) m.Result = (IntPtr)11;
      else if (t) m.Result = (IntPtr)12; else if (b) m.Result = (IntPtr)15;
      return;
    }
    base.WndProc(ref m);
  }
}
'@

# sharp on every screen: the window in real pixels, not stretched by Windows
[TileWindow]::SetProcessDpiAwarenessContext([IntPtr]::new(-4)) | Out-Null
$env:PATH = "$lib;$env:PATH"
$data = Join-Path $env:LOCALAPPDATA 'live-code-dashboard\tiles'
[System.Windows.Forms.Application]::EnableVisualStyles()
$store = Join-Path $env:USERPROFILE '.claude\live-code-tiles.json'
[TileWindow]::SetCurrentProcessExplicitAppUserModelID('LiveCode.Tile') | Out-Null
# the dashboard's own icon (the variant set-icon.ps1 picked), for the window and its taskbar button
$icon = $null
try {
  $variant = (Get-Content (Join-Path $here '..\icons\active.txt') -ErrorAction Stop).Trim()
} catch { $variant = 'diff' }
$png = Join-Path $here "..\icons\$variant-256.png"
if (Test-Path $png) { $icon = [System.Drawing.Icon]::FromHandle(([System.Drawing.Bitmap]::new($png)).GetHicon()) }
[System.Windows.Forms.Application]::Run([TileWindow]::new($Key, $Url, $data, $lib, $store, [System.Drawing.Rectangle]::new($X, $Y, $W, $H), $Top.IsPresent, $View, $icon))

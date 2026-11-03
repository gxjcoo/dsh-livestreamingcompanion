/**
 * 游戏标签页里的 Minecraft 实时预览：直接抓摄像机客户端窗口，不经过 OBS。
 * 一个常驻 PowerShell/C# 进程用 PrintWindow 读窗口（被别的窗口挡住也能抓），缩小成 JPEG 后按
 * 「4 字节小端长度 + JPEG」写进 stdout。只有游戏标签要看实时画面时才运行。
 */
import { spawn, spawnSync, type ChildProcessByStdio } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';

const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** stdout 的二进制分帧：允许一次收到半帧或好几帧 */
export class FrameDecoder {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const frames: Buffer[] = [];
    while (this.pending.length >= 4) {
      const size = this.pending.readUInt32LE(0);
      if (size === 0 || size > MAX_FRAME_BYTES) throw new Error(`invalid preview frame size: ${size}`);
      if (this.pending.length < size + 4) break;
      frames.push(this.pending.subarray(4, size + 4));
      this.pending = this.pending.subarray(size + 4);
    }
    return frames;
  }
}

export class CameraPreview {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private key = '';

  constructor(
    private readonly dir: string,
    private readonly onFrame: (jpeg: Buffer) => void,
    private readonly log?: (text: string) => void,
  ) {}

  start(pid: number, fps: number): void {
    if (process.platform !== 'win32' || !pid || fps <= 0) return;
    const key = `${pid}:${fps}`;
    if (this.child && this.key === key) return;
    this.stop();
    this.key = key;
    fs.mkdirSync(this.dir, { recursive: true });
    const source = path.join(this.dir, 'preview.cs');
    fs.writeFileSync(source, PREVIEW_CS);
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const script = [
      `$ProgressPreference = 'SilentlyContinue'`,
      `Add-Type -TypeDefinition ([IO.File]::ReadAllText(${q(source)})) -ReferencedAssemblies System.Drawing`,
      `[DshCameraPreview]::Run(${pid}, ${Math.max(1, Math.min(15, Math.round(fps)))})`,
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    const decoder = new FrameDecoder();
    child.stdout.on('data', (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) this.onFrame(frame);
      } catch (err) {
        this.log?.(`[camera-preview] ${(err as Error).message}`);
        if (this.child === child) this.stop();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.log?.(`[camera-preview] ${text}`);
    });
    child.on('error', (err) => {
      this.log?.(`[camera-preview] ${err.message}`);
      if (this.child === child) { this.child = null; this.key = ''; }
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.key = '';
      if (code !== 0) this.log?.(`[camera-preview] exited (${code})`);
    });
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.key = '';
    if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  }
}

/** 窗口捕获本身：全窗口抓下来后只取客户区，预览里不带 Minecraft 的标题栏和边框 */
const PREVIEW_CS = String.raw`
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class DshCameraPreview {
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);

  public static void Run(int pid, int fps) {
    SetProcessDPIAware();
    var game = Process.GetProcessById(pid);
    var output = Console.OpenStandardOutput();
    var codec = FindJpeg();
    var quality = new EncoderParameters(1);
    quality.Param[0] = new EncoderParameter(Encoder.Quality, 75L);
    int delay = Math.Max(66, 1000 / Math.Max(1, fps));
    while (true) {
      game.Refresh();
      if (game.HasExited) return;
      try {
        Capture(game.MainWindowHandle, codec, quality, output);
      } catch (IOException) {
        return; // 页面关了，Node 已把 stdout 收走
      } catch (Exception e) {
        Console.Error.WriteLine(e.Message);
        Thread.Sleep(500);
      }
      Thread.Sleep(delay);
    }
  }

  static ImageCodecInfo FindJpeg() {
    foreach (var codec in ImageCodecInfo.GetImageEncoders()) if (codec.FormatID == ImageFormat.Jpeg.Guid) return codec;
    throw new InvalidOperationException("No JPEG encoder");
  }

  static void Capture(IntPtr window, ImageCodecInfo codec, EncoderParameters quality, Stream output) {
    if (window == IntPtr.Zero) return;
    RECT outer, client;
    if (!GetWindowRect(window, out outer) || !GetClientRect(window, out client)) return;
    var origin = new POINT { X = 0, Y = 0 };
    ClientToScreen(window, ref origin);
    int fullW = outer.R - outer.L, fullH = outer.B - outer.T;
    int clientW = client.R - client.L, clientH = client.B - client.T;
    int x = origin.X - outer.L, y = origin.Y - outer.T;
    if (fullW <= 0 || fullH <= 0 || clientW <= 0 || clientH <= 0 || x < 0 || y < 0 || x + clientW > fullW || y + clientH > fullH) return;
    using (var full = new Bitmap(fullW, fullH)) {
      using (var g = Graphics.FromImage(full)) {
        var dc = g.GetHdc();
        try { if (!PrintWindow(window, dc, 2)) return; } finally { g.ReleaseHdc(dc); }
      }
      double scale = Math.Min(960.0 / clientW, 540.0 / clientH);
      int width = Math.Max(1, (int)Math.Round(clientW * scale));
      int height = Math.Max(1, (int)Math.Round(clientH * scale));
      using (var preview = new Bitmap(width, height)) {
        using (var g = Graphics.FromImage(preview)) {
          g.InterpolationMode = InterpolationMode.HighQualityBicubic;
          g.PixelOffsetMode = PixelOffsetMode.Half;
          g.DrawImage(full, new Rectangle(0, 0, width, height), new Rectangle(x, y, clientW, clientH), GraphicsUnit.Pixel);
        }
        using (var jpeg = new MemoryStream()) {
          preview.Save(jpeg, codec, quality);
          var bytes = jpeg.ToArray();
          var header = BitConverter.GetBytes(bytes.Length);
          output.Write(header, 0, header.Length);
          output.Write(bytes, 0, bytes.Length);
          output.Flush();
        }
      }
    }
  }
}
`;

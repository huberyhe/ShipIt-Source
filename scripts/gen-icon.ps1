# 1) Remove outer white border of source icon (flood fill from edges -> transparent)
# 2) Scale to multi-size PNGs into build/icon-gen/
# Uses inlined C# for reliable pixel access (PowerShell loop over 1.5M px is slow/unreliable).
# Keep this file ASCII-only (PowerShell 5.1 reads without BOM as ANSI).
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root 'build\icon.png'
$outDir = Join-Path $root 'build\icon-gen'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

Add-Type -ReferencedAssemblies 'System.Drawing' -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class IconCleaner {
    public static void RemoveWhiteBorder(string src, string dst, int threshold) {
        using (var bmp = new Bitmap(src)) {
            var rect = new Rectangle(0, 0, bmp.Width, bmp.Height);
            var data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
            int stride = data.Stride, w = bmp.Width, h = bmp.Height;
            var bytes = new byte[stride * h];
            Marshal.Copy(data.Scan0, bytes, 0, bytes.Length);

            var visited = new bool[w * h];
            var q = new Queue<int>();
            // seeds: four edges (idx = y*w + x)
            for (int x = 0; x < w; x++) { q.Enqueue(x); q.Enqueue(x + (h - 1) * w); }
            for (int y = 0; y < h; y++) { q.Enqueue(y * w); q.Enqueue(y * w + w - 1); }

            while (q.Count > 0) {
                int idx = q.Dequeue();
                if (visited[idx]) continue;
                visited[idx] = true;
                int x = idx % w, y = idx / w, off = y * stride + x * 4;
                // BGRA order: bytes[off]=B, off+1=G, off+2=R, off+3=A
                if (bytes[off] > threshold && bytes[off + 1] > threshold && bytes[off + 2] > threshold) {
                    bytes[off + 3] = 0; // white -> transparent
                    if (x > 0) q.Enqueue(idx - 1);
                    if (x < w - 1) q.Enqueue(idx + 1);
                    if (y > 0) q.Enqueue(idx - w);
                    if (y < h - 1) q.Enqueue(idx + w);
                }
            }
            Marshal.Copy(bytes, 0, data.Scan0, bytes.Length);
            bmp.UnlockBits(data);
            bmp.Save(dst, ImageFormat.Png);
        }
    }
}
"@

$clean = Join-Path $outDir 'icon-clean.png'
[IconCleaner]::RemoveWhiteBorder($src, $clean, 245)
Write-Host "white border removed -> $clean"

# Scale to multiple sizes (alpha preserved)
$bmp = [System.Drawing.Bitmap]::FromFile($clean)
foreach ($s in 256, 128, 64, 48, 32, 16) {
  $thumb = New-Object System.Drawing.Bitmap($bmp, $s, $s)
  $thumb.Save((Join-Path $outDir "icon_$s.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $thumb.Dispose()
  Write-Host "generated $s x $s"
}
$bmp.Dispose()

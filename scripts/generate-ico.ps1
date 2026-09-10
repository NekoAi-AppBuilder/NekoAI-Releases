Add-Type -AssemblyName System.Drawing

function Convert-PngToIco {
    param (
        [string]$InputPngPath,
        [string]$OutputIcoPath,
        [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
    )

    $srcImage = [System.Drawing.Image]::FromFile($InputPngPath)
    
    $pngStreams = @()
    foreach ($size in $Sizes) {
        $bmp = New-Object System.Drawing.Bitmap $size, $size
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $g.DrawImage($srcImage, 0, 0, $size, $size)
        $g.Dispose()

        $ms = New-Object System.IO.MemoryStream
        $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $pngStreams += @{
            Size = $size
            Data = $ms.ToArray()
        }
        $ms.Dispose()
    }
    $srcImage.Dispose()

    $fs = New-Object System.IO.FileStream $OutputIcoPath, ([System.IO.FileMode]::Create), ([System.IO.FileAccess]::Write)
    $bw = New-Object System.IO.BinaryWriter $fs

    # ICONDIR structure
    $bw.Write([uint16]0) # Reserved
    $bw.Write([uint16]1) # Type (1 = ICO)
    $bw.Write([uint16]$pngStreams.Count) # Count

    # Calculate offsets
    $offset = 6 + ($pngStreams.Count * 16)

    # ICONDIRENTRY structure for each image
    foreach ($item in $pngStreams) {
        $w = if ($item.Size -ge 256) { [byte]0 } else { [byte]$item.Size }
        $h = if ($item.Size -ge 256) { [byte]0 } else { [byte]$item.Size }
        $bw.Write($w) # Width
        $bw.Write($h) # Height
        $bw.Write([byte]0) # Color count
        $bw.Write([byte]0) # Reserved
        $bw.Write([uint16]1) # Color planes
        $bw.Write([uint16]32) # Bits per pixel
        $bw.Write([uint32]$item.Data.Length) # Image bytes size
        $bw.Write([uint32]$offset) # Offset to image data
        $offset += $item.Data.Length
    }

    # Write actual image data (PNG format for all entries)
    foreach ($item in $pngStreams) {
        $bw.Write($item.Data)
    }

    $bw.Flush()
    $bw.Close()
    $fs.Close()
    Write-Host "ICO successfully generated at $OutputIcoPath"
}

Convert-PngToIco -InputPngPath "$PWD\build\icon.png" -OutputIcoPath "$PWD\build\icon.ico"

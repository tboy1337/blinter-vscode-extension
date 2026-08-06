const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const iconsDir = path.join(__dirname, '..', 'icons');
const icoFile = path.join(iconsDir, 'blinter_icon.ico');
const pngFile = path.join(iconsDir, 'blinter-logo.png');
const upstreamIcoUrl = 'https://raw.githubusercontent.com/tboy1337/Blinter/refs/heads/main/resources/blinter_icon.ico';

function downloadUpstreamIcon() {
  console.log('Downloading upstream Blinter icon...');
  const result = cp.spawnSync(
    'curl.exe',
    ['-L', '-f', '-o', icoFile, upstreamIcoUrl],
    { encoding: 'utf8' }
  );
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`Failed to download Blinter icon: ${detail}`);
  }
  if (!fs.existsSync(icoFile) || fs.statSync(icoFile).size < 1000) {
    throw new Error('Downloaded Blinter icon is missing or too small.');
  }
  console.log('Wrote', icoFile);
}

function convertIcoToPng() {
  if (!fs.existsSync(icoFile)) {
    throw new Error(`ICO file not found: ${icoFile}`);
  }

  const psScript = [
    'Add-Type -AssemblyName System.Drawing',
    `$icon = New-Object System.Drawing.Icon('${icoFile.replace(/'/g, "''")}')`,
    '$bitmap = $icon.ToBitmap()',
    `$bitmap.Save('${pngFile.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)`,
    '$icon.Dispose()',
    '$bitmap.Dispose()'
  ].join('; ');

  const result = cp.spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    { encoding: 'utf8' }
  );

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`Failed to convert ICO to PNG: ${detail}`);
  }

  if (!fs.existsSync(pngFile) || fs.statSync(pngFile).size < 500) {
    throw new Error('PNG icon was not created successfully.');
  }

  console.log('Wrote', pngFile);
}

const mode = process.argv[2];
if (mode === '--fetch') {
  downloadUpstreamIcon();
  convertIcoToPng();
} else if (fs.existsSync(icoFile)) {
  convertIcoToPng();
} else {
  downloadUpstreamIcon();
  convertIcoToPng();
}

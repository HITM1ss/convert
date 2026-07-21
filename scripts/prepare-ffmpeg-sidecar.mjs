import { createWriteStream, existsSync } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";

const target = process.argv[2] ?? process.env.TAURI_ENV_TARGET_TRIPLE;
const sources = {
  "aarch64-apple-darwin": {
    url: "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64",
    archive: false,
  },
  "x86_64-pc-windows-msvc": {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-win64-lgpl-8.1.zip",
    archive: true,
  },
  "aarch64-pc-windows-msvc": {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n8.1-latest-winarm64-lgpl-8.1.zip",
    archive: true,
  },
};

if (!target || !sources[target]) {
  throw new Error(`不支持的 FFmpeg sidecar 目标：${target ?? "未提供"}`);
}

const binaryName = target.includes("windows") ? `ffmpeg-${target}.exe` : `ffmpeg-${target}`;
const destinationDirectory = join("src-tauri", "binaries");
const destination = join(destinationDirectory, binaryName);
if (existsSync(destination)) {
  console.log(`已找到 FFmpeg sidecar：${destination}`);
  process.exit(0);
}

await mkdir(destinationDirectory, { recursive: true });
const source = sources[target];
const temporary = join(destinationDirectory, basename(source.url));
console.log(`下载 FFmpeg sidecar：${target}`);
const response = await fetch(source.url);
if (!response.ok || !response.body) {
  throw new Error(`无法下载 FFmpeg sidecar：${response.status} ${response.statusText}`);
}
await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));

try {
  if (source.archive) {
    const extractionDirectory = join(destinationDirectory, `${target}-extract`);
    await mkdir(extractionDirectory, { recursive: true });
    const extract = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        `Expand-Archive -LiteralPath '${temporary}' -DestinationPath '${extractionDirectory}' -Force; $binary = Get-ChildItem -Path '${extractionDirectory}' -Filter ffmpeg.exe -Recurse | Select-Object -First 1; if ($null -eq $binary) { exit 1 }; Move-Item -LiteralPath $binary.FullName -Destination '${destination}' -Force`,
      ],
      { stdio: "inherit" },
    );
    await rm(extractionDirectory, { recursive: true, force: true });
    if (extract.status !== 0 || !existsSync(destination)) {
      throw new Error("无法从 FFmpeg 发布包中提取 ffmpeg.exe。");
    }
  } else {
    await rename(temporary, destination);
  }
  if (!target.includes("windows")) {
    await chmod(destination, 0o755);
  }
  console.log(`FFmpeg sidecar 已准备：${destination}`);
} finally {
  if (existsSync(temporary)) {
    await rm(temporary);
  }
}
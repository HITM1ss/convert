use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tauri_plugin_shell::process::CommandEvent;
use tauri_plugin_shell::ShellExt;

pub struct VideoGifConverter;

impl VideoGifConverter {
    pub fn create_thumbnail(
        source: &Path,
        cache_directory: &Path,
        app_handle: &tauri::AppHandle,
    ) -> Result<PathBuf, String> {
        fs::create_dir_all(cache_directory)
            .map_err(|error| format!("无法创建视频缩略图缓存：{error}"))?;
        let output = cache_directory.join(format!("{:x}.jpg", path_hash(source)));
        if output.is_file() {
            return Ok(output);
        }

        let result = tauri::async_runtime::block_on(
            app_handle
                .shell()
                .sidecar("ffmpeg")
                .map_err(|error| format!("应用内置的 FFmpeg 不可用，请重新安装 Format Forge：{error}"))?
                .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", "0.1", "-i"])
                .arg(source)
                .args(["-frames:v", "1", "-vf", "scale=320:-2"])
                .arg(&output)
                .output(),
        )
        .map_err(|error| format!("无法生成视频缩略图：{error}"))?;

        if result.status.success() && output.is_file() {
            Ok(output)
        } else {
            let _ = fs::remove_file(&output);
            Err("无法读取视频画面。".to_owned())
        }
    }

    pub fn convert(
        source: &Path,
        output: &Path,
        app_handle: &tauri::AppHandle,
        cancellation_requested: &AtomicBool,
    ) -> Result<(), String> {
        let temporary = output.with_extension("tmp.gif");
        let filter = "fps=10,scale='min(960,iw)':-2:flags=lanczos,split[frames][palette];[palette]palettegen=max_colors=256[colors];[frames][colors]paletteuse=dither=sierra2_4a";
        let command = app_handle
            .shell()
            .sidecar("ffmpeg")
            .map_err(|error| format!("应用内置的 FFmpeg 不可用，请重新安装 Format Forge：{error}"))?;
        let (mut receiver, child) = command
            .args([
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-y",
                    "-i",
                ])
                .arg(source)
                .args(["-filter_complex", filter, "-loop", "0", "-f", "gif"])
                .arg(&temporary)
                .spawn()
            .map_err(|error| format!("无法启动应用内置的 FFmpeg：{error}"))?;
        let mut stderr = Vec::new();
        let completed = tauri::async_runtime::block_on(async {
            loop {
                if cancellation_requested.load(Ordering::Relaxed) {
                    let _ = child.kill();
                    return Err("已停止".to_owned());
                }
                match tokio::time::timeout(Duration::from_millis(80), receiver.recv()).await {
                    Ok(Some(CommandEvent::Stderr(output))) => stderr.extend(output),
                    Ok(Some(CommandEvent::Terminated(status))) => return Ok(status.code == Some(0)),
                    Ok(Some(CommandEvent::Error(error))) => return Err(error),
                    Ok(Some(_)) | Err(_) => {}
                    Ok(None) => return Ok(false),
                }
            }
        });

        let succeeded = completed?;

        if !succeeded {
            let _ = fs::remove_file(&temporary);
            let message = String::from_utf8_lossy(&stderr).trim().to_owned();
            return Err(if message.is_empty() {
                "FFmpeg 未能转换该视频。".to_owned()
            } else {
                format!("FFmpeg 转换失败：{message}")
            });
        }

        fs::rename(&temporary, output).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("无法保存 GIF：{error}")
        })
    }
}

fn path_hash(path: &Path) -> u64 {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    hasher.finish()
}
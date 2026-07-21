mod application;
mod domain;
mod infrastructure;

use std::fs::{self, OpenOptions};
use std::io::Write;

use application::job_service::convert_batch;
use domain::conversion::{ConversionRequest, ConversionResult, ConversionStatus, SupportedFormat};
use tauri::{Emitter, Manager};

fn log_directory_path(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let directory = app_handle
        .path()
        .app_log_dir()
        .map_err(|error| format!("无法获取日志目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建日志目录：{error}"))?;
    Ok(directory)
}

fn video_thumbnail_directory(app_handle: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app_handle
        .path()
        .app_cache_dir()
        .map(|directory| directory.join("video-thumbnails"))
        .map_err(|error| format!("无法获取视频缩略图缓存：{error}"))
}

#[tauri::command]
fn supported_formats() -> Vec<SupportedFormat> {
    SupportedFormat::all()
}

#[tauri::command]
async fn convert_images(
    app_handle: tauri::AppHandle,
    request: ConversionRequest,
) -> Vec<ConversionResult> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut log = log_directory_path(&app_handle)
            .ok()
            .and_then(|directory| OpenOptions::new().create(true).append(true).open(directory.join("conversion.log")).ok());
        if let Some(log) = &mut log {
            let _ = writeln!(log, "开始转换：{} 个文件，目标格式 {:?}", request.source_paths.len(), request.target_format);
        }
        convert_batch(request, &app_handle, |result| {
            if let Some(log) = &mut log {
                let _ = writeln!(log, "结果：{:?}", result);
            }
            let _ = app_handle.emit("conversion-progress", result);
        })
    })
        .await
        .unwrap_or_else(|error| {
            vec![ConversionResult {
                source_path: String::new(),
                output_path: None,
                output_size: None,
                status: ConversionStatus::Failed,
                message: Some(format!("转换任务异常结束：{error}")),
            }]
        })
}

#[tauri::command]
fn log_directory(app_handle: tauri::AppHandle) -> Result<String, String> {
    log_directory_path(&app_handle).map(|directory| directory.to_string_lossy().into_owned())
}

#[tauri::command]
fn file_sizes(paths: Vec<String>) -> Vec<Option<u64>> {
    paths
        .into_iter()
        .map(|path| std::fs::metadata(path).ok().map(|metadata| metadata.len()))
        .collect()
}

    #[tauri::command]
    fn image_dimensions(paths: Vec<String>) -> Vec<Option<(u32, u32)>> {
        paths
        .into_iter()
        .map(|path| infrastructure::raster_image_converter::image_dimensions(std::path::Path::new(&path)))
        .collect()
    }

#[tauri::command]
fn video_thumbnails(app_handle: tauri::AppHandle, paths: Vec<String>) -> Vec<Option<String>> {
    let cache_directory = match video_thumbnail_directory(&app_handle) {
        Ok(directory) => directory,
        Err(_) => return paths.into_iter().map(|_| None).collect(),
    };
    paths
        .into_iter()
        .map(|path| {
            infrastructure::video_gif_converter::VideoGifConverter::create_thumbnail(
                std::path::Path::new(&path),
                &cache_directory,
                &app_handle,
            )
            .ok()
            .map(|thumbnail| thumbnail.to_string_lossy().into_owned())
        })
        .collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![supported_formats, convert_images, file_sizes, image_dimensions, video_thumbnails, log_directory])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

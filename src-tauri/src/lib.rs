mod application;
mod domain;
mod infrastructure;

use std::sync::atomic::{AtomicBool, Ordering};

use application::job_service::convert_batch;
use domain::conversion::{ConversionRequest, ConversionResult, ConversionStatus, SupportedFormat};
use tauri::{Emitter, Manager};

struct ConversionControl(AtomicBool);

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
    app_handle
        .state::<ConversionControl>()
        .0
        .store(false, Ordering::Relaxed);
    tauri::async_runtime::spawn_blocking(move || {
        let cancellation_requested = app_handle.state::<ConversionControl>();
        convert_batch(request, &app_handle, &cancellation_requested.0, |result| {
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
fn stop_conversion(app_handle: tauri::AppHandle) {
    app_handle
        .state::<ConversionControl>()
        .0
        .store(true, Ordering::Relaxed);
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
        .manage(ConversionControl(AtomicBool::new(false)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![supported_formats, convert_images, stop_conversion, file_sizes, image_dimensions, video_thumbnails])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

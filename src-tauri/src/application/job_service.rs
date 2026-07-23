use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::domain::conversion::{ConversionRequest, ConversionResult, ConversionStatus, SupportedFormat};
use crate::infrastructure::{raster_image_converter::RasterImageConverter, svg_converter::SvgConverter, video_gif_converter::VideoGifConverter};

pub fn convert_batch<F>(
    request: ConversionRequest,
    app_handle: &tauri::AppHandle,
    cancellation_requested: &AtomicBool,
    mut on_result: F,
) -> Vec<ConversionResult>
where
    F: FnMut(&ConversionResult),
{
    let output_directory = Path::new(&request.output_directory);
    if !output_directory.is_dir() {
        let results = request
            .source_paths
            .into_iter()
            .map(|source_path| ConversionResult {
                source_path,
                output_path: None,
                output_size: None,
                status: ConversionStatus::Failed,
                message: Some("输出目录不存在或无法访问。".to_owned()),
            })
            .collect::<Vec<_>>();
        results.iter().for_each(&mut on_result);
        return results;
    }

    let mut results = Vec::with_capacity(request.source_paths.len());
    let mut source_paths = request.source_paths.into_iter();
    while let Some(source_path) = source_paths.next() {
        if cancellation_requested.load(Ordering::Relaxed) {
            let result = cancelled_result(source_path);
            on_result(&result);
            results.push(result);
            for source_path in source_paths {
                let result = cancelled_result(source_path);
                on_result(&result);
                results.push(result);
            }
            break;
        }
            let source = Path::new(&source_path);
            let output = unique_output_path(output_directory, source, request.target_format.extension());
            let crop_region = request.crop_regions.get(&source_path);
            let output_dimensions = request.output_dimensions.get(&source_path);
            let conversion = match request.target_format {
                SupportedFormat::Gif if is_video(source) => {
                    VideoGifConverter::convert(source, &output, app_handle, cancellation_requested)
                }
                SupportedFormat::Svg if is_svg(source) => SvgConverter::copy(source, &output),
                SupportedFormat::Svg if is_video(source) || is_gif(source) => {
                    Err("仅支持将静态图片转换为路径 SVG。".to_owned())
                }
                SupportedFormat::Svg => SvgConverter::vectorize(source, &output),
                format => RasterImageConverter::convert(source, &output, format, request.quality, request.compression_mode, crop_region, output_dimensions, request.ico_size),
            };
            let result = match conversion {
                Ok(()) => ConversionResult {
                    source_path,
                    output_path: Some(output.to_string_lossy().into_owned()),
                    output_size: std::fs::metadata(&output).ok().map(|metadata| metadata.len()),
                    status: ConversionStatus::Completed,
                    message: None,
                },
                Err(_) if cancellation_requested.load(Ordering::Relaxed) => cancelled_result(source_path),
                Err(error) => ConversionResult {
                    source_path,
                    output_path: None,
                    output_size: None,
                    status: ConversionStatus::Failed,
                    message: Some(error),
                },
            };
            on_result(&result);
            results.push(result);
    }
    results
}

fn cancelled_result(source_path: String) -> ConversionResult {
    ConversionResult {
        source_path,
        output_path: None,
        output_size: None,
        status: ConversionStatus::Cancelled,
        message: Some("已停止".to_owned()),
    }
}

fn is_video(source: &Path) -> bool {
    matches!(
        source.extension().and_then(|extension| extension.to_str()),
        Some(extension) if matches!(extension.to_ascii_lowercase().as_str(), "mp4" | "mov" | "m4v" | "avi" | "mkv" | "webm")
    )
}

fn is_svg(source: &Path) -> bool {
    matches!(source.extension().and_then(|extension| extension.to_str()), Some(extension) if extension.eq_ignore_ascii_case("svg"))
}

fn is_gif(source: &Path) -> bool {
    matches!(source.extension().and_then(|extension| extension.to_str()), Some(extension) if extension.eq_ignore_ascii_case("gif"))
}

fn unique_output_path(output_directory: &Path, source: &Path, extension: &str) -> PathBuf {
    let stem = source.file_stem().and_then(|name| name.to_str()).unwrap_or("converted");
    let mut candidate = output_directory.join(format!("{stem}.{extension}"));
    let mut index = 1;
    while candidate.exists() {
        candidate = output_directory.join(format!("{stem} ({index}).{extension}"));
        index += 1;
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::{is_video, unique_output_path};
    use std::path::Path;

    #[test]
    fn uses_target_extension_for_output_name() {
        assert_eq!(
            unique_output_path(Path::new("/tmp"), Path::new("source/photo.png"), "jpg"),
            Path::new("/tmp/photo.jpg")
        );
    }

    #[test]
    fn recognizes_supported_video_extensions() {
        assert!(is_video(Path::new("clip.MOV")));
        assert!(!is_video(Path::new("photo.png")));
    }
}
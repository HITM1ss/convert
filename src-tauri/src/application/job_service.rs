use std::path::{Path, PathBuf};

use crate::domain::conversion::{ConversionRequest, ConversionResult, ConversionStatus};
use crate::infrastructure::raster_image_converter::RasterImageConverter;

pub fn convert_batch<F>(request: ConversionRequest, mut on_result: F) -> Vec<ConversionResult>
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

    request
        .source_paths
        .into_iter()
        .map(|source_path| {
            let source = Path::new(&source_path);
            let output = unique_output_path(output_directory, source, request.target_format.extension());
            let crop_region = request.crop_regions.get(&source_path);
            let result = match RasterImageConverter::convert(source, &output, request.target_format, request.quality, request.compression_mode, crop_region, request.ico_size) {
                Ok(()) => ConversionResult {
                    source_path,
                    output_path: Some(output.to_string_lossy().into_owned()),
                    output_size: std::fs::metadata(&output).ok().map(|metadata| metadata.len()),
                    status: ConversionStatus::Completed,
                    message: None,
                },
                Err(error) => ConversionResult {
                    source_path,
                    output_path: None,
                    output_size: None,
                    status: ConversionStatus::Failed,
                    message: Some(error),
                },
            };
            on_result(&result);
            result
        })
        .collect()
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
    use super::unique_output_path;
    use std::path::Path;

    #[test]
    fn uses_target_extension_for_output_name() {
        assert_eq!(
            unique_output_path(Path::new("/tmp"), Path::new("source/photo.png"), "jpg"),
            Path::new("/tmp/photo.jpg")
        );
    }
}
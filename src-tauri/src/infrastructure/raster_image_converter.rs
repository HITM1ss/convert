use std::fs;
use std::io::Cursor;
use std::path::Path;

use image::{DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat};

use crate::domain::conversion::SupportedFormat;

pub struct RasterImageConverter;

impl RasterImageConverter {
    pub fn convert(source: &Path, output: &Path, format: SupportedFormat, quality: u8) -> Result<(), String> {
        let input_format = image::ImageFormat::from_path(source)
            .map_err(|_| "无法识别输入文件格式。".to_owned())?;
        if matches!(input_format, ImageFormat::Gif) {
            return Err("暂不支持动画图片转换。".to_owned());
        }

        let image = image::open(source).map_err(|error| format!("无法读取图片：{error}"))?;
        let temporary = output.with_extension(format!("{}.tmp", format.extension()));
        Self::write_image(&image, &temporary, format, quality)?;
        fs::rename(&temporary, output).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("无法保存转换结果：{error}")
        })
    }

    fn write_image(image: &DynamicImage, output: &Path, format: SupportedFormat, quality: u8) -> Result<(), String> {
        let mut encoded = Vec::new();
        match format {
            SupportedFormat::Jpeg => image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, quality)
                .encode_image(image),
            SupportedFormat::Webp => image::codecs::webp::WebPEncoder::new_lossless(&mut encoded)
                .encode(image.as_bytes(), image.width(), image.height(), image.color().into()),
            SupportedFormat::Avif => {
                let rgba = image.to_rgba8();
                image::codecs::avif::AvifEncoder::new_with_speed_quality(&mut encoded, 10, quality)
                    .write_image(rgba.as_raw(), rgba.width(), rgba.height(), ExtendedColorType::Rgba8)
            }
            target => image.write_to(&mut Cursor::new(&mut encoded), image_format(target)),
        }
        .map_err(|error| format!("无法编码目标图片：{error}"))?;
        fs::write(output, encoded).map_err(|error| format!("无法写入临时文件：{error}"))
    }
}

fn image_format(format: SupportedFormat) -> ImageFormat {
    match format {
        SupportedFormat::Jpeg => ImageFormat::Jpeg,
        SupportedFormat::Png => ImageFormat::Png,
        SupportedFormat::Webp => ImageFormat::WebP,
        SupportedFormat::Bmp => ImageFormat::Bmp,
        SupportedFormat::Tiff => ImageFormat::Tiff,
        SupportedFormat::Ico => ImageFormat::Ico,
        SupportedFormat::Avif => ImageFormat::Avif,
    }
}
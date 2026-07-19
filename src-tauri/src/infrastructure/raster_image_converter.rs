use std::fs;
use std::io::Cursor;
use std::path::Path;

use image::{imageops::FilterType, DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat};

use crate::domain::conversion::{CompressionMode, CropRegion, SupportedFormat};

pub struct RasterImageConverter;

impl RasterImageConverter {
    pub fn convert(source: &Path, output: &Path, format: SupportedFormat, quality: u8, compression_mode: CompressionMode, crop_region: Option<&CropRegion>, ico_size: u32) -> Result<(), String> {
        let image = read_image(source)?;
        let image = match format {
            SupportedFormat::Ico => {
                let cropped = match crop_region {
                    Some(region) => crop_to_region(image, region)?,
                    None => image,
                };
                resize_ico(cropped, ico_size)?
            }
            _ => image,
        };
        let temporary = output.with_extension(format!("{}.tmp", format.extension()));
        Self::write_image(&image, &temporary, format, quality, compression_mode)?;
        fs::rename(&temporary, output).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("无法保存转换结果：{error}")
        })
    }

    fn write_image(image: &DynamicImage, output: &Path, format: SupportedFormat, quality: u8, compression_mode: CompressionMode) -> Result<(), String> {
        let mut encoded = Vec::new();
        match format {
            SupportedFormat::Jpeg => image::codecs::jpeg::JpegEncoder::new_with_quality(&mut encoded, quality)
                .encode_image(image),
            SupportedFormat::Webp => match compression_mode {
                CompressionMode::Lossy => encode_lossy_webp(image, &mut encoded, quality),
                CompressionMode::Lossless => image::codecs::webp::WebPEncoder::new_lossless(&mut encoded)
                    .encode(image.as_bytes(), image.width(), image.height(), image.color().into()),
            },
            SupportedFormat::Avif => {
                let rgba = image.to_rgba8();
                image::codecs::avif::AvifEncoder::new_with_speed_quality(&mut encoded, 10, quality)
                    .write_image(rgba.as_raw(), rgba.width(), rgba.height(), ExtendedColorType::Rgba8)
            }
            SupportedFormat::Heic => image.write_with_encoder(
                heif::HeifEncoder::new(&mut encoded).with_quality(quality),
            ),
            target => image.write_to(&mut Cursor::new(&mut encoded), image_format(target)),
        }
        .map_err(|error| format!("无法编码目标图片：{error}"))?;
        fs::write(output, encoded).map_err(|error| format!("无法写入临时文件：{error}"))
    }
}

pub fn image_dimensions(source: &Path) -> Option<(u32, u32)> {
    if is_heif(source) {
        let encoded = fs::read(source).ok()?;
        let info = heif::probe(&encoded).ok()?;
        Some((info.width, info.height))
    } else {
        image::image_dimensions(source).ok()
    }
}

fn read_image(source: &Path) -> Result<DynamicImage, String> {
    if is_heif(source) {
        let encoded = fs::read(source).map_err(|error| format!("无法读取 HEIC 图片：{error}"))?;
        return heif::decode(&encoded).map_err(|error| format!("无法解码 HEIC 图片：{error}"));
    }

    let input_format = image::ImageFormat::from_path(source)
        .map_err(|_| "无法识别输入文件格式。".to_owned())?;
    if matches!(input_format, ImageFormat::Gif) {
        return Err("暂不支持动画图片转换。".to_owned());
    }
    image::open(source).map_err(|error| format!("无法读取图片：{error}"))
}

fn is_heif(source: &Path) -> bool {
    matches!(source.extension().and_then(|extension| extension.to_str()), Some(extension) if extension.eq_ignore_ascii_case("heic") || extension.eq_ignore_ascii_case("heif"))
}

fn encode_lossy_webp(image: &DynamicImage, encoded: &mut Vec<u8>, quality: u8) -> image::ImageResult<()> {
    let rgba = image.to_rgba8();
    let encoder = webp::Encoder::from_rgba(rgba.as_raw(), rgba.width(), rgba.height());
    encoded.extend_from_slice(&encoder.encode(quality as f32));
    Ok(())
}

fn crop_to_region(image: DynamicImage, region: &CropRegion) -> Result<DynamicImage, String> {
    if region.width == 0
        || region.height == 0
        || region.x.checked_add(region.width).is_none_or(|right| right > image.width())
        || region.y.checked_add(region.height).is_none_or(|bottom| bottom > image.height())
    {
        return Err("ICO 裁剪区域无效。".to_owned());
    }

    Ok(image.crop_imm(region.x, region.y, region.width, region.height))
}

fn resize_ico(image: DynamicImage, size: u32) -> Result<DynamicImage, String> {
    if !matches!(size, 16 | 32 | 64 | 256) {
        return Err("ICO 输出分辨率无效。".to_owned());
    }

    Ok(image.resize_exact(size, size, FilterType::Lanczos3))
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
        SupportedFormat::Heic => unreachable!("HEIC uses the dedicated heif encoder"),
    }
}
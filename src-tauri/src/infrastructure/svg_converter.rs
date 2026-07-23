use std::fs;
use std::path::Path;

use image::{DynamicImage, ImageFormat};
use resvg::{tiny_skia, usvg};
use vtracer::{convert_image_to_svg, Config, Preset};

use crate::infrastructure::raster_image_converter::read_image;

pub struct SvgConverter;

impl SvgConverter {
    pub fn copy(source: &Path, output: &Path) -> Result<(), String> {
        fs::copy(source, output)
            .map(|_| ())
            .map_err(|error| format!("无法复制 SVG 文件：{error}"))
    }

    pub fn vectorize(source: &Path, output: &Path) -> Result<(), String> {
        const MAX_VECTORIZE_DIMENSION: u32 = 512;

        let image = read_image(source)?;
        let image = if image.width() > MAX_VECTORIZE_DIMENSION || image.height() > MAX_VECTORIZE_DIMENSION {
            image.resize(
                MAX_VECTORIZE_DIMENSION,
                MAX_VECTORIZE_DIMENSION,
                image::imageops::FilterType::Lanczos3,
            )
        } else {
            image
        };
        let input = output.with_extension("vector-input.png");
        let temporary = output.with_extension("tmp.svg");
        image
            .write_to(&mut std::io::BufWriter::new(fs::File::create(&input).map_err(|error| format!("无法创建矢量化输入：{error}"))?), ImageFormat::Png)
            .map_err(|error| format!("无法准备矢量化输入：{error}"))?;

        let result = convert_image_to_svg(&input, &temporary, Config::from_preset(Preset::Photo))
            .map_err(|error| format!("无法生成路径 SVG：{error}"));
        let _ = fs::remove_file(&input);
        result?;

        fs::rename(&temporary, output).map_err(|error| {
            let _ = fs::remove_file(&temporary);
            format!("无法保存路径 SVG：{error}")
        })
    }

    pub fn rasterize(source: &Path) -> Result<DynamicImage, String> {
        let data = fs::read(source).map_err(|error| format!("无法读取 SVG：{error}"))?;
        let mut options = usvg::Options::default();
        options.fontdb_mut().load_system_fonts();
        let tree = usvg::Tree::from_data(&data, &options)
            .map_err(|error| format!("无法解析 SVG：{error}"))?;
        let size = tree.size().to_int_size();
        let mut pixmap = tiny_skia::Pixmap::new(size.width(), size.height())
            .ok_or_else(|| "SVG 尺寸无效。".to_owned())?;
        resvg::render(&tree, tiny_skia::Transform::default(), &mut pixmap.as_mut());
        let image = image::RgbaImage::from_raw(size.width(), size.height(), pixmap.take())
            .ok_or_else(|| "无法渲染 SVG 图像。".to_owned())?;
        Ok(DynamicImage::ImageRgba8(image))
    }
}

#[cfg(test)]
mod tests {
    use super::SvgConverter;

    #[test]
    fn vectorizes_a_png_as_svg_paths() {
        let directory = std::env::temp_dir().join(format!("format-forge-svg-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create temporary directory");
        let source = directory.join("source.png");
        let output = directory.join("output.svg");
        image::RgbaImage::from_pixel(4, 4, image::Rgba([29, 155, 240, 255]))
            .save(&source)
            .expect("write source PNG");

        SvgConverter::vectorize(&source, &output).expect("vectorize PNG");
        let svg = std::fs::read_to_string(&output).expect("read SVG");
        assert!(svg.contains("<path d="));
        assert!(!svg.contains("<image"));
        let _ = std::fs::remove_dir_all(directory);
    }
}
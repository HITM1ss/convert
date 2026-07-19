use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SupportedFormat {
    Jpeg,
    Png,
    Webp,
    Bmp,
    Tiff,
    Ico,
    Avif,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompressionMode {
    Lossy,
    Lossless,
}

impl SupportedFormat {
    pub fn all() -> Vec<Self> {
        vec![Self::Jpeg, Self::Png, Self::Webp, Self::Bmp, Self::Tiff, Self::Ico, Self::Avif]
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Webp => "webp",
            Self::Bmp => "bmp",
            Self::Tiff => "tiff",
            Self::Ico => "ico",
            Self::Avif => "avif",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionRequest {
    pub source_paths: Vec<String>,
    pub output_directory: String,
    pub target_format: SupportedFormat,
    pub quality: u8,
    #[serde(default = "default_compression_mode")]
    pub compression_mode: CompressionMode,
    #[serde(default)]
    pub crop_regions: HashMap<String, CropRegion>,
    #[serde(default = "default_ico_size")]
    pub ico_size: u32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CropRegion {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

fn default_ico_size() -> u32 {
    256
}

fn default_compression_mode() -> CompressionMode {
    CompressionMode::Lossy
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversionResult {
    pub source_path: String,
    pub output_path: Option<String>,
    pub output_size: Option<u64>,
    pub status: ConversionStatus,
    pub message: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ConversionStatus {
    Completed,
    Failed,
}
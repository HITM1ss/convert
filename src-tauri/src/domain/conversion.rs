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
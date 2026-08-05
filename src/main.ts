import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ImageFormat = "jpeg" | "gif" | "png" | "webp" | "bmp" | "tiff" | "ico" | "avif" | "heic" | "svg";
type VideoFormat = "mp4" | "webm" | "mov";
type Format = ImageFormat | VideoFormat;
type Result = { sourcePath: string; outputPath?: string; outputSize?: number; status: "completed" | "failed" | "cancelled"; message?: string };
type Dimensions = [number, number];
type CropRegion = { x: number; y: number; width: number; height: number };
type OutputDimensions = { width: number; height: number };
type CompressionMode = "lossy" | "lossless";

const imageFormats: Record<ImageFormat, string> = { jpeg: "JPG", gif: "GIF", png: "PNG", webp: "WebP", bmp: "BMP", tiff: "TIFF", ico: "ICO", avif: "AVIF", heic: "HEIC", svg: "SVG" };
const videoFormats: Record<VideoFormat, string> = { mp4: "MP4", webm: "WebM", mov: "MOV" };
const formats: Record<Format, string> = { ...imageFormats, ...videoFormats };
let sourcePaths: string[] = [];
let outputDirectory = "";

const byId = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const fileList = byId<HTMLDivElement>("file-list");
const appWindow = getCurrentWebviewWindow();
const nativeWindow = getCurrentWindow();
const imageOptions = byId<HTMLDivElement>("image-options");
const imageQualityInput = byId<HTMLInputElement>("quality-input");
const imageQualityValue = byId<HTMLOutputElement>("quality-value");
const videoQualityInput = byId<HTMLInputElement>("video-quality-input");
const videoQualityValue = byId<HTMLOutputElement>("video-quality-value");
const compressionMode = byId<HTMLDivElement>("compression-mode");
const videoOptions = byId<HTMLDivElement>("video-options");
const convertButton = byId<HTMLButtonElement>("convert-button");
const statusMessage = byId<HTMLButtonElement>("status-message");
const formatNav = byId<HTMLElement>("format-nav");
const formatSectionToggle = byId<HTMLButtonElement>("format-section-toggle");
const formatSidebar = byId<HTMLElement>("format-sidebar");
const imageFormatSection = byId<HTMLElement>("image-format-section");
const videoFormatSection = byId<HTMLElement>("video-format-section");
const icoCropDialog = byId<HTMLDialogElement>("ico-crop-dialog");
const icoCropImage = byId<HTMLImageElement>("ico-crop-image");
const icoCropStage = byId<HTMLDivElement>("ico-crop-stage");
const icoCropSelection = byId<HTMLDivElement>("ico-crop-selection");
const icoCropConfirm = byId<HTMLButtonElement>("ico-crop-confirm");
const imageCropDialog = byId<HTMLDialogElement>("image-crop-dialog");
const imageCropImage = byId<HTMLImageElement>("image-crop-image");
const imageCropStage = byId<HTMLDivElement>("image-crop-stage");
const imageCropSelection = byId<HTMLDivElement>("image-crop-selection");
const imageCropConfirm = byId<HTMLButtonElement>("image-crop-confirm");
const imageCropWidthInput = byId<HTMLInputElement>("image-crop-width-input");
const imageCropHeightInput = byId<HTMLInputElement>("image-crop-height-input");
const imageCropAspectLock = byId<HTMLInputElement>("image-crop-aspect-lock");
const imageCropSourceDimensions = byId<HTMLSpanElement>("image-crop-source-dimensions");
const icoSizeOptions = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="ico-size"]'));
let targetFormat: Format = "jpeg";
let selectedCompressionMode: CompressionMode = "lossy";
let activeFormatCategory: "image" | "video" = "image";
let formatCategoryAnimationFrame: number | undefined;
const fileSizes = new Map<string, number>();
const imageDimensions = new Map<string, Dimensions>();
const videoThumbnails = new Map<string, string>();
const icoCropRegions = new Map<string, CropRegion>();
const outputDimensions = new Map<string, OutputDimensions>();
const taskResults = new Map<string, Result>();
let isConverting = false;
let isStopping = false;
let statusScrollFrame: number | undefined;
let statusLink: string | undefined;
let icoCropQueue: string[] = [];
let icoCropIndex = 0;
let formatBeforeIco: Format = "jpeg";
let icoSize = 256;
let icoCropDisplayRegion = { x: 0, y: 0, width: 0, height: 0 };
let icoCropImageBounds = { x: 0, y: 0, width: 0, height: 0 };
let icoCropPointer: { mode: "move" | "resize"; startX: number; startY: number; region: typeof icoCropDisplayRegion } | null = null;
let imageCropPath: string | null = null;
let imageCropDisplayRegion = { x: 0, y: 0, width: 0, height: 0 };
let imageCropImageBounds = { x: 0, y: 0, width: 0, height: 0 };
let imageCropPointer: { mode: "move" | "resize"; handle: "x" | "y" | "corner" | null; startX: number; startY: number; region: typeof imageCropDisplayRegion } | null = null;
let imageCropLockedAspectRatio: number | null = null;

function formatFileSize(bytes?: number) {
  if (bytes === undefined) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function setStatusMessage(message: string, link?: string) {
  statusMessage.textContent = message;
  statusLink = link;
  statusMessage.title = link ? "打开 GitHub 仓库" : "复制当前信息";
  statusMessage.setAttribute("aria-label", statusMessage.title);
}

function isNewerVersion(latest: string, current: string) {
  const parse = (version: string) => version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const latestParts = parse(latest);
  const currentParts = parse(current);
  const length = Math.max(latestParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    if ((latestParts[index] ?? 0) !== (currentParts[index] ?? 0)) return (latestParts[index] ?? 0) > (currentParts[index] ?? 0);
  }
  return false;
}

async function checkForNewVersion() {
  try {
    const response = await fetch("https://api.github.com/repos/HITM1ss/convert/releases/latest", {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return;
    const release = await response.json() as { tag_name?: string };
    const currentVersion = await getVersion();
    if (release.tag_name && isNewerVersion(release.tag_name, currentVersion)) {
      setStatusMessage("当前有新版本发布", "https://github.com/HITM1ss/convert");
    }
  } catch {
    // The update check is optional and must not affect offline conversion.
  }
}

function isVideoPath(path: string) {
  return /\.(mp4|mov|m4v|avi|mkv|webm)$/i.test(path);
}

function isVideoFormat(format: Format): format is VideoFormat {
  return format in videoFormats;
}

function isGifPath(path: string) {
  return /\.gif$/i.test(path);
}

function importExtensions() {
  return ["jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif", "ico", "avif", "heic", "heif", "svg", "mp4", "mov", "m4v", "avi", "mkv", "webm"];
}

function isSupportedImport(path: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension !== undefined && importExtensions().includes(extension);
}

function videoThumbnail(path: string) {
  const preview = videoThumbnails.get(path);
  const image = preview ? `<img src="${convertFileSrc(preview)}" alt="" />` : '<span class="video-marker" aria-hidden="true">视频</span>';
  return `${image}<span class="video-play-indicator" aria-hidden="true"></span>`;
}

async function createVideoThumbnails(paths: string[]) {
  const videos = paths.filter(isVideoPath);
  if (!videos.length) return;
  const thumbnails = await invoke<Array<string | null>>("video_thumbnails", { paths: videos });
  thumbnails.forEach((thumbnail, index) => {
    if (thumbnail) videoThumbnails.set(videos[index], thumbnail);
  });
}

function stopStatusScroll() {
  if (statusScrollFrame !== undefined) cancelAnimationFrame(statusScrollFrame);
  statusScrollFrame = undefined;
  statusMessage.scrollLeft = 0;
}

function startStatusScroll() {
  stopStatusScroll();
  const maximumScroll = statusMessage.scrollWidth - statusMessage.clientWidth;
  if (maximumScroll <= 0) return;

  const pauseDuration = 700;
  const travelDuration = Math.max(1200, maximumScroll * 14);
  let direction = 1;
  let phaseStartedAt: number | undefined;
  let isPaused = true;

  const animate = (timestamp: number) => {
    phaseStartedAt ??= timestamp;
    const elapsed = timestamp - phaseStartedAt;
    const duration = isPaused ? pauseDuration : travelDuration;
    if (elapsed >= duration) {
      if (!isPaused) statusMessage.scrollLeft = direction === 1 ? maximumScroll : 0;
      isPaused = !isPaused;
      if (isPaused) direction *= -1;
      phaseStartedAt = timestamp;
    } else if (!isPaused) {
      const progress = elapsed / travelDuration;
      statusMessage.scrollLeft = direction === 1 ? progress * maximumScroll : (1 - progress) * maximumScroll;
    }
    statusScrollFrame = requestAnimationFrame(animate);
  };
  statusScrollFrame = requestAnimationFrame(animate);
}

function renderExportControl() {
  if (isConverting) {
    convertButton.disabled = false;
    convertButton.innerHTML = '<span>停止</span><span aria-hidden="true">&#9632;</span>';
    convertButton.title = "停止转换";
    convertButton.setAttribute("aria-label", "停止转换");
    return;
  }
  const label = outputDirectory ? "转换" : "选择路径";
  convertButton.innerHTML = `<span>${label}</span><span aria-hidden="true">&#8594;</span>`;
  convertButton.title = outputDirectory ? "转换" : "选择导出路径";
  convertButton.setAttribute("aria-label", convertButton.title);
}

function renderTaskQueue() {
  const queue = byId<HTMLDivElement>("task-queue-list");
  const completed = sourcePaths.filter((path) => taskResults.has(path)).length;
  const progress = sourcePaths.length ? Math.round((completed / sourcePaths.length) * 100) : 0;
  byId("queue-progress").textContent = `${progress}%`;
  queue.innerHTML = sourcePaths.length
    ? sourcePaths.map((path, index) => {
      const result = taskResults.get(path);
      const name = path.split(/[\\/]/).pop() ?? path;
      const state = result ? (result.status === "completed" ? "完成" : result.status === "cancelled" ? "已停止" : "失败") : isConverting && index === completed ? "转换中" : "等待";
      const details = result?.status === "completed"
        ? `${formats[targetFormat]} · ${formatFileSize(fileSizes.get(path))} &#8594; ${formatFileSize(result.outputSize)}`
        : formats[targetFormat];
      const thumbnail = isVideoPath(path)
        ? videoThumbnail(path)
        : `<img src="${convertFileSrc(path)}" alt="" />`;
      return `<div class="task-queue-row"><span class="queue-thumbnail ${isVideoPath(path) ? "is-video" : ""}">${thumbnail}</span><span class="queue-file"><span>${name}</span><small>${details}</small></span><span class="queue-state ${result?.status ?? (state === "转换中" ? "converting" : "pending")}">${state}</span></div>`;
    }).join("")
    : '<p class="task-queue-empty">暂无任务</p>';
}

function renderFiles(results: Result[] = []) {
  const resultByPath = new Map(results.map((result) => [result.sourcePath, result]));
  fileList.classList.toggle("is-empty", sourcePaths.length === 0);
  const fileRows = sourcePaths.map((path, index) => {
    const result = resultByPath.get(path);
    const name = path.split(/[\\/]/).pop() ?? path;
    const state = result ? (result.status === "completed" ? "完成" : result.status === "cancelled" ? "已停止" : result.message ?? "失败") : "待处理";
      const thumbnail = isVideoPath(path)
        ? videoThumbnail(path)
      : `<img src="${convertFileSrc(path)}" alt="" />`;
    const cropButton = !isVideoPath(path)
      ? `<button class="crop-file-button" type="button" data-file-index="${index}" title="裁剪图片" aria-label="裁剪 ${name}">裁剪</button>`
      : "";
    return `<div class="file-row"><span class="file-thumbnail ${isVideoPath(path) ? "is-video" : ""}">${thumbnail}</span><span class="file-name">${name}</span><span class="file-state ${result?.status ?? "pending"}">${state}</span><span class="file-size">${formatFileSize(fileSizes.get(path))}</span>${cropButton}<button class="remove-file-button" type="button" data-file-index="${index}" title="移除文件" aria-label="移除 ${name}">&times;</button></div>`;
  }).join("");
  fileList.innerHTML = fileRows
    ? `${fileRows}<button class="add-file-button" type="button"><span aria-hidden="true">+</span>添加文件</button>`
    : '<button class="empty-state" type="button"><span>打开</span>/拖入文件</button>';
  convertButton.disabled = !sourcePaths.length && !isConverting;
  renderExportControl();
  renderTaskQueue();
}

async function addSourcePaths(paths: string[]) {
  const supportedPaths = paths.filter(isSupportedImport);
  const addedPaths = supportedPaths.filter((path) => !sourcePaths.includes(path));
  sourcePaths = [...new Set([...sourcePaths, ...supportedPaths])];
  renderFiles();
  if (!addedPaths.length) return;
  const sizes = await invoke<Array<number | null>>("file_sizes", { paths: addedPaths });
  const dimensions = await invoke<Array<Dimensions | null>>("image_dimensions", { paths: addedPaths });
  addedPaths.forEach((path, index) => {
    const size = sizes[index];
    if (size !== null) fileSizes.set(path, size);
    const imageSize = dimensions[index];
    if (imageSize !== null) imageDimensions.set(path, imageSize);
  });
  renderFiles();
  await createVideoThumbnails(addedPaths);
  renderFiles();
  if (targetFormat === "ico") void startIcoCropping();
}

async function addFiles() {
  const selected = await open({ multiple: true, directory: false, filters: [{ name: "图片和视频", extensions: importExtensions() }] });
  if (!selected) return;
  await addSourcePaths(Array.isArray(selected) ? selected : [selected]);
}

async function chooseOutputDirectory(): Promise<boolean> {
  const selected = await open({ directory: true, multiple: false });
  if (!selected || Array.isArray(selected)) return false;
  outputDirectory = selected;
  renderExportControl();
  renderFiles();
  return true;
}

async function convert() {
  if (isConverting) {
    if (isStopping) return;
    isStopping = true;
    convertButton.disabled = true;
    setStatusMessage("正在停止转换...");
    try {
      await invoke("stop_conversion");
    } catch (error) {
      isStopping = false;
      renderExportControl();
      setStatusMessage(`无法停止转换：${String(error)}`);
    }
    return;
  }
  if (!sourcePaths.length) return;
  if (isVideoFormat(targetFormat)) {
    setStatusMessage("视频格式转换引擎尚未接入；当前仅提供界面设置。");
    return;
  }
  if (!outputDirectory) {
    await chooseOutputDirectory();
    return;
  }
  if (targetFormat === "svg" && sourcePaths.some((path) => isVideoPath(path) || isGifPath(path))) {
    setStatusMessage("SVG 仅支持静态图片；GIF 和视频无法转换为路径 SVG。");
    return;
  }
  if (targetFormat === "ico" && await startIcoCropping()) return;
  convertButton.disabled = true;
  isConverting = true;
  taskResults.clear();
  renderExportControl();
  renderTaskQueue();
  setStatusMessage("转换中...");
  const cropRegions = Object.fromEntries(icoCropRegions);
  try {
    const results = await invoke<Result[]>("convert_images", { request: { sourcePaths, outputDirectory, targetFormat, quality: Number(imageQualityInput.value), compressionMode: selectedCompressionMode, cropRegions, outputDimensions: Object.fromEntries(outputDimensions), icoSize } });
    results.forEach((result) => taskResults.set(result.sourcePath, result));
    renderFiles(results);
    const completed = results.filter((result) => result.status === "completed").length;
    const cancelled = results.filter((result) => result.status === "cancelled").length;
    setStatusMessage(cancelled ? `已完成 ${completed}/${results.length}，已停止 ${cancelled} 项` : `已完成 ${completed}/${results.length}`);
  } catch (error) {
    setStatusMessage(`转换失败：${String(error)}`);
  } finally {
    isConverting = false;
    isStopping = false;
    renderFiles([...taskResults.values()]);
  }
}

function renderFormats() {
  formatNav.innerHTML = Object.entries(imageFormats).map(([value, label]) =>
    `<button class="format-button ${value === targetFormat ? "is-active" : ""}" data-format="${value}">${label}</button>`
  ).join("");
}

function renderVideoFormats() {
  const videoFormatNav = byId<HTMLElement>("video-format-nav");
  videoFormatNav.innerHTML = Object.entries(videoFormats).map(([value, label]) =>
    `<button class="format-button ${value === targetFormat ? "is-active" : ""}" data-format="${value}">${label}</button>`
  ).join("");
}

function renderCompressionMode() {
  if (isVideoFormat(targetFormat)) {
    imageOptions.hidden = true;
    videoOptions.hidden = false;
    return;
  }
  imageOptions.hidden = false;
  videoOptions.hidden = true;
  const isSupported = targetFormat === "webp";
  compressionMode.classList.toggle("is-disabled", !isSupported);
  compressionMode.classList.toggle("is-lossless", selectedCompressionMode === "lossless");
  imageQualityInput.disabled = targetFormat === "gif" || targetFormat === "svg" || (isSupported && selectedCompressionMode === "lossless");
  compressionMode.querySelectorAll<HTMLButtonElement>("[data-compression-mode]").forEach((button) => {
    button.disabled = !isSupported;
    button.classList.toggle("is-active", button.dataset.compressionMode === selectedCompressionMode);
  });
}

function setActiveFormatCategory(category: "image" | "video") {
  activeFormatCategory = category;
  const isVideoActive = category === "video";
  const videoSectionToggle = byId<HTMLButtonElement>("video-section-toggle");
  const videoFormatNav = byId("video-format-nav");
  const activeNav = isVideoActive ? videoFormatNav : formatNav;
  formatSidebar.prepend(isVideoActive ? videoFormatSection : imageFormatSection);
  formatSectionToggle.setAttribute("aria-expanded", "false");
  videoSectionToggle.setAttribute("aria-expanded", "false");
  formatNav.classList.add("is-collapsed");
  videoFormatNav.classList.add("is-collapsed");
  if (formatCategoryAnimationFrame !== undefined) cancelAnimationFrame(formatCategoryAnimationFrame);
  formatCategoryAnimationFrame = requestAnimationFrame(() => {
    if (activeFormatCategory !== category) return;
    (isVideoActive ? videoSectionToggle : formatSectionToggle).setAttribute("aria-expanded", "true");
    activeNav.classList.remove("is-collapsed");
    formatCategoryAnimationFrame = undefined;
  });
}

function isIcoCropRequired(path: string) {
  return imageDimensions.has(path) && !icoCropRegions.has(path);
}

async function startIcoCropping(paths = sourcePaths.filter(isIcoCropRequired)) {
  if (icoCropDialog.open) return true;
  icoCropQueue = paths.filter((path) => imageDimensions.has(path));
  icoCropIndex = 0;
  if (!icoCropQueue.length) return false;
  await showNextIcoCrop();
  return true;
}

async function showNextIcoCrop() {
  const path = icoCropQueue[icoCropIndex];
  if (!path) {
    icoCropDialog.close();
    return;
  }
  byId("ico-crop-progress").textContent = `${icoCropIndex + 1} / ${icoCropQueue.length}`;
  icoCropConfirm.textContent = icoCropIndex === icoCropQueue.length - 1 ? "完成" : "下一张";
  if (!icoCropDialog.open) icoCropDialog.showModal();
  icoCropImage.src = convertFileSrc(path);
  await new Promise<void>((resolve, reject) => {
    icoCropImage.onload = () => resolve();
    icoCropImage.onerror = () => reject(new Error("无法加载待裁剪图片"));
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const previewScale = Math.min(
      icoCropStage.clientWidth / icoCropImage.naturalWidth,
      icoCropStage.clientHeight / icoCropImage.naturalHeight,
    );
    icoCropImage.style.width = `${Math.max(1, Math.floor(icoCropImage.naturalWidth * previewScale))}px`;
    icoCropImage.style.height = `${Math.max(1, Math.floor(icoCropImage.naturalHeight * previewScale))}px`;
  const stageBounds = icoCropStage.getBoundingClientRect();
  const imageBounds = icoCropImage.getBoundingClientRect();
  icoCropImageBounds = {
    x: imageBounds.left - stageBounds.left,
    y: imageBounds.top - stageBounds.top,
    width: imageBounds.width,
    height: imageBounds.height,
  };
  const size = Math.min(icoCropImageBounds.width, icoCropImageBounds.height) * 0.8;
  icoCropDisplayRegion = {
    x: icoCropImageBounds.x + (icoCropImageBounds.width - size) / 2,
    y: icoCropImageBounds.y + (icoCropImageBounds.height - size) / 2,
    width: size,
    height: size,
  };
  renderIcoCropSelection();
}

function renderIcoCropSelection() {
  icoCropSelection.style.left = `${icoCropDisplayRegion.x}px`;
  icoCropSelection.style.top = `${icoCropDisplayRegion.y}px`;
  icoCropSelection.style.width = `${icoCropDisplayRegion.width}px`;
  icoCropSelection.style.height = `${icoCropDisplayRegion.height}px`;
}

function currentImageCropDimensions() {
  if (!imageCropPath) return null;
  const [width, height] = imageDimensions.get(imageCropPath)!;
  return {
    width: Math.max(1, Math.round(imageCropDisplayRegion.width * width / imageCropImageBounds.width)),
    height: Math.max(1, Math.round(imageCropDisplayRegion.height * height / imageCropImageBounds.height)),
  };
}

function resetImageCropResolutionInputs() {
  const dimensions = currentImageCropDimensions();
  if (!dimensions) return;
  imageCropWidthInput.value = "";
  imageCropHeightInput.value = "";
  imageCropWidthInput.placeholder = String(dimensions.width);
  imageCropHeightInput.placeholder = String(dimensions.height);
}

function updateImageCropResolutionPlaceholders() {
  const dimensions = currentImageCropDimensions();
  if (!dimensions) return;
  imageCropWidthInput.placeholder = String(dimensions.width);
  imageCropHeightInput.placeholder = String(dimensions.height);
}

function updateImageCropAspectRatio() {
  const requestedWidth = Number(imageCropWidthInput.value);
  const requestedHeight = Number(imageCropHeightInput.value);
  if (requestedWidth <= 0 || requestedHeight <= 0) return;

  const ratio = requestedWidth / requestedHeight;
  const maximumWidth = imageCropImageBounds.x + imageCropImageBounds.width - imageCropDisplayRegion.x;
  const maximumHeight = imageCropImageBounds.y + imageCropImageBounds.height - imageCropDisplayRegion.y;
  const maximumWidthForRatio = Math.min(maximumWidth, maximumHeight * ratio);
  const minimumWidth = Math.min(24, maximumWidthForRatio);
  imageCropDisplayRegion.width = Math.max(minimumWidth, Math.min(imageCropDisplayRegion.width, maximumWidthForRatio));
  imageCropDisplayRegion.height = imageCropDisplayRegion.width / ratio;
  renderImageCropSelection();
}

function currentImageCropAspectRatio() {
  const requestedWidth = Number(imageCropWidthInput.value);
  const requestedHeight = Number(imageCropHeightInput.value);
  if (requestedWidth > 0 && requestedHeight > 0) return requestedWidth / requestedHeight;
  const dimensions = currentImageCropDimensions();
  return dimensions ? dimensions.width / dimensions.height : null;
}

function setImageCropAspectLock() {
  if (!imageCropAspectLock.checked) {
    imageCropLockedAspectRatio = null;
    return;
  }
  const dimensions = currentImageCropDimensions();
  if (!dimensions) return;
  const width = Number(imageCropWidthInput.value) || dimensions.width;
  const height = Number(imageCropHeightInput.value) || dimensions.height;
  imageCropWidthInput.value = String(width);
  imageCropHeightInput.value = String(height);
  imageCropLockedAspectRatio = width / height;
  updateImageCropAspectRatio();
}

function updateLockedImageCropResolution(changedDimension: "width" | "height") {
  if (imageCropAspectLock.checked) {
    const ratio = imageCropLockedAspectRatio ?? currentImageCropAspectRatio();
    const changedInput = changedDimension === "width" ? imageCropWidthInput : imageCropHeightInput;
    const otherInput = changedDimension === "width" ? imageCropHeightInput : imageCropWidthInput;
    const value = Number(changedInput.value);
    if (ratio && value > 0) {
      otherInput.value = String(Math.max(1, Math.round(changedDimension === "width" ? value / ratio : value * ratio)));
    }
  }
  updateImageCropAspectRatio();
}

function resizeLockedImageCrop(handle: "x" | "y" | "corner" | null, deltaX: number, deltaY: number) {
  if (!imageCropPointer) return;
  const { region } = imageCropPointer;
  const ratio = region.width / region.height;
  const maximumWidth = imageCropImageBounds.x + imageCropImageBounds.width - region.x;
  const maximumHeight = imageCropImageBounds.y + imageCropImageBounds.height - region.y;
  const maximumWidthForRatio = Math.min(maximumWidth, maximumHeight * ratio);
  const minimumWidth = Math.min(24, maximumWidthForRatio);
  let width: number;

  if (handle === "y") width = region.width + deltaY * ratio;
  else if (handle === "corner") {
    const widthScale = deltaX / region.width;
    const heightScale = deltaY / region.height;
    width = region.width * (1 + (Math.abs(widthScale) >= Math.abs(heightScale) ? widthScale : heightScale));
  } else width = region.width + deltaX;

  imageCropDisplayRegion.width = Math.max(minimumWidth, Math.min(width, maximumWidthForRatio));
  imageCropDisplayRegion.height = imageCropDisplayRegion.width / ratio;
}

async function startFileCropping(path: string) {
  if (imageCropDialog.open || !imageDimensions.has(path)) return;
  imageCropPath = path;
  const [sourceWidth, sourceHeight] = imageDimensions.get(path)!;
  imageCropSourceDimensions.textContent = `原图 ${sourceWidth} × ${sourceHeight}`;
  imageCropDialog.showModal();
  imageCropImage.src = convertFileSrc(path);
  await new Promise<void>((resolve, reject) => {
    imageCropImage.onload = () => resolve();
    imageCropImage.onerror = () => reject(new Error("无法加载待裁剪图片"));
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const previewScale = Math.min(
    imageCropStage.clientWidth / imageCropImage.naturalWidth,
    imageCropStage.clientHeight / imageCropImage.naturalHeight,
  );
  imageCropImage.style.width = `${Math.max(1, Math.floor(imageCropImage.naturalWidth * previewScale))}px`;
  imageCropImage.style.height = `${Math.max(1, Math.floor(imageCropImage.naturalHeight * previewScale))}px`;
  const stageBounds = imageCropStage.getBoundingClientRect();
  const imageBounds = imageCropImage.getBoundingClientRect();
  imageCropImageBounds = { x: imageBounds.left - stageBounds.left, y: imageBounds.top - stageBounds.top, width: imageBounds.width, height: imageBounds.height };
  imageCropDisplayRegion = { ...imageCropImageBounds };
  resetImageCropResolutionInputs();
  renderImageCropSelection();
}

function renderImageCropSelection() {
  imageCropSelection.style.left = `${imageCropDisplayRegion.x}px`;
  imageCropSelection.style.top = `${imageCropDisplayRegion.y}px`;
  imageCropSelection.style.width = `${imageCropDisplayRegion.width}px`;
  imageCropSelection.style.height = `${imageCropDisplayRegion.height}px`;
}

function saveCurrentIcoCrop() {
  const path = icoCropQueue[icoCropIndex];
  const [width, height] = imageDimensions.get(path)!;
  const scaleX = width / icoCropImageBounds.width;
  const scaleY = height / icoCropImageBounds.height;
  const x = Math.max(0, Math.min(Math.round((icoCropDisplayRegion.x - icoCropImageBounds.x) * scaleX), width - 1));
  const y = Math.max(0, Math.min(Math.round((icoCropDisplayRegion.y - icoCropImageBounds.y) * scaleY), height - 1));
  const size = Math.max(1, Math.min(Math.round(icoCropDisplayRegion.width * scaleX), Math.round(icoCropDisplayRegion.height * scaleY), width - x, height - y));
  icoCropRegions.set(path, {
    x,
    y,
    width: size,
    height: size,
  });
}

function saveImageCrop() {
  const path = imageCropPath;
  if (!path) return;
  const [width, height] = imageDimensions.get(path)!;
  const scaleX = width / imageCropImageBounds.width;
  const scaleY = height / imageCropImageBounds.height;
  const x = Math.max(0, Math.min(Math.round((imageCropDisplayRegion.x - imageCropImageBounds.x) * scaleX), width - 1));
  const y = Math.max(0, Math.min(Math.round((imageCropDisplayRegion.y - imageCropImageBounds.y) * scaleY), height - 1));
  const cropWidth = Math.max(1, Math.min(Math.round(imageCropDisplayRegion.width * scaleX), width - x));
  const cropHeight = Math.max(1, Math.min(Math.round(imageCropDisplayRegion.height * scaleY), height - y));
  icoCropRegions.set(path, { x, y, width: cropWidth, height: cropHeight });
  const requestedWidth = Number(imageCropWidthInput.value);
  const requestedHeight = Number(imageCropHeightInput.value);
  if (requestedWidth > 0 && requestedHeight > 0) outputDimensions.set(path, { width: requestedWidth, height: requestedHeight });
  else outputDimensions.delete(path);
}

function cancelIcoCropping() {
  icoCropQueue.forEach((path) => icoCropRegions.delete(path));
  icoCropQueue = [];
  icoCropDialog.close();
  targetFormat = formatBeforeIco;
  renderFormats();
  renderTaskQueue();
}

byId("title-bar").addEventListener("pointerdown", (event) => {
  if ((event.target as HTMLElement).closest("button")) return;
  void nativeWindow.startDragging();
});
document.querySelectorAll<HTMLButtonElement>(".window-control").forEach((button) => {
  button.addEventListener("pointerdown", (event) => event.stopPropagation());
});
byId("window-minimize").addEventListener("click", () => void nativeWindow.minimize());
byId("window-maximize").addEventListener("click", () => {
  void nativeWindow.toggleMaximize().then(async () => {
    const maximized = await nativeWindow.isMaximized();
    const button = byId<HTMLButtonElement>("window-maximize");
    button.title = maximized ? "还原窗口" : "最大化";
    button.setAttribute("aria-label", button.title);
    button.querySelector("span")!.textContent = maximized ? "❐" : "□";
  });
});
byId("window-close").addEventListener("click", () => void nativeWindow.close());
imageQualityInput.addEventListener("input", () => imageQualityValue.textContent = imageQualityInput.value);
videoQualityInput.addEventListener("input", () => videoQualityValue.textContent = videoQualityInput.value);
compressionMode.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-compression-mode]");
  if (!button || button.disabled) return;
  selectedCompressionMode = button.dataset.compressionMode as CompressionMode;
  renderCompressionMode();
});
formatNav.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-format]");
  if (!button) return;
  const nextFormat = button.dataset.format as Format;
  if (nextFormat === "ico" && targetFormat !== "ico") formatBeforeIco = targetFormat;
  targetFormat = nextFormat;
  renderFormats();
  renderCompressionMode();
  renderTaskQueue();
  if (targetFormat === "ico") void startIcoCropping();
});
byId("video-format-nav").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-format]");
  if (!button) return;
  targetFormat = button.dataset.format as VideoFormat;
  renderFormats();
  renderVideoFormats();
  renderCompressionMode();
  renderTaskQueue();
});
formatSectionToggle.addEventListener("click", () => {
  setActiveFormatCategory("image");
});
byId("video-section-toggle").addEventListener("click", () => {
  setActiveFormatCategory("video");
});
fileList.addEventListener("click", (event) => {
  if ((event.target as HTMLElement).closest(".empty-state, .add-file-button")) void addFiles();
  const cropButton = (event.target as HTMLElement).closest<HTMLButtonElement>(".crop-file-button");
  if (cropButton) {
    const path = sourcePaths[Number(cropButton.dataset.fileIndex)];
    if (targetFormat === "ico") void startIcoCropping([path]);
    else void startFileCropping(path);
    return;
  }
  const removeButton = (event.target as HTMLElement).closest<HTMLButtonElement>(".remove-file-button");
  if (!removeButton) return;
  const [removedPath] = sourcePaths.splice(Number(removeButton.dataset.fileIndex), 1);
  fileSizes.delete(removedPath);
  imageDimensions.delete(removedPath);
  videoThumbnails.delete(removedPath);
  icoCropRegions.delete(removedPath);
  outputDimensions.delete(removedPath);
  renderFiles();
});
fileList.addEventListener("error", (event) => {
  if (event.target instanceof HTMLImageElement) event.target.closest(".file-thumbnail")?.classList.add("is-unavailable");
}, true);
byId("convert-button").addEventListener("click", () => void convert());
statusMessage.addEventListener("click", () => {
  void (async () => {
    try {
      if (statusLink) {
        await openUrl(statusLink);
        return;
      }
      const message = statusMessage.textContent?.trim();
      if (!message) {
        setStatusMessage("当前没有可复制的信息");
        return;
      }
      await navigator.clipboard.writeText(message);
      setStatusMessage("已复制当前信息");
    } catch (error) {
      setStatusMessage(`无法复制当前信息：${String(error)}`);
    }
  })();
});
statusMessage.addEventListener("mouseenter", startStatusScroll);
statusMessage.addEventListener("mouseleave", stopStatusScroll);
icoCropConfirm.addEventListener("click", () => {
  saveCurrentIcoCrop();
  icoCropIndex += 1;
  void showNextIcoCrop();
});
icoSizeOptions.forEach((option) => {
  option.addEventListener("change", () => {
    if (option.checked) icoSize = Number(option.value);
  });
});
icoCropDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  cancelIcoCropping();
});
icoCropStage.addEventListener("pointerdown", (event) => {
  const target = event.target as HTMLElement;
  if (target !== icoCropSelection && !target.closest(".crop-handle")) return;
  icoCropPointer = {
    mode: target.closest(".crop-handle") ? "resize" : "move",
    startX: event.clientX,
    startY: event.clientY,
    region: { ...icoCropDisplayRegion },
  };
  icoCropStage.setPointerCapture(event.pointerId);
});
icoCropStage.addEventListener("pointermove", (event) => {
  if (!icoCropPointer) return;
  if (icoCropPointer.mode === "move") {
    const maximumX = icoCropImageBounds.x + icoCropImageBounds.width - icoCropPointer.region.width;
    const maximumY = icoCropImageBounds.y + icoCropImageBounds.height - icoCropPointer.region.height;
    icoCropDisplayRegion.x = Math.max(
      icoCropImageBounds.x,
      Math.min(icoCropPointer.region.x + event.clientX - icoCropPointer.startX, maximumX),
    );
    icoCropDisplayRegion.y = Math.max(
      icoCropImageBounds.y,
      Math.min(icoCropPointer.region.y + event.clientY - icoCropPointer.startY, maximumY),
    );
    renderIcoCropSelection();
    return;
  }
  const delta = Math.max(event.clientX - icoCropPointer.startX, event.clientY - icoCropPointer.startY);
  const maximumSize = Math.min(icoCropImageBounds.x + icoCropImageBounds.width - icoCropPointer.region.x, icoCropImageBounds.y + icoCropImageBounds.height - icoCropPointer.region.y);
  const minimumSize = Math.min(24, maximumSize);
  const size = Math.max(minimumSize, Math.min(icoCropPointer.region.width + delta, maximumSize));
  icoCropDisplayRegion.width = size;
  icoCropDisplayRegion.height = size;
  renderIcoCropSelection();
});
icoCropStage.addEventListener("pointerup", () => { icoCropPointer = null; });
imageCropConfirm.addEventListener("click", () => {
  saveImageCrop();
  imageCropPath = null;
  imageCropDialog.close();
  renderFiles();
});
imageCropDialog.addEventListener("cancel", () => { imageCropPath = null; });
imageCropStage.addEventListener("pointerdown", (event) => {
  const target = event.target as HTMLElement;
  const handle = target.closest(".crop-handle");
  if (target !== imageCropSelection && !handle) return;
  const cropHandle = handle?.classList.contains("crop-handle-x") ? "x" : handle?.classList.contains("crop-handle-y") ? "y" : handle ? "corner" : null;
  imageCropPointer = { mode: handle ? "resize" : "move", handle: cropHandle, startX: event.clientX, startY: event.clientY, region: { ...imageCropDisplayRegion } };
  imageCropStage.setPointerCapture(event.pointerId);
});
imageCropStage.addEventListener("pointermove", (event) => {
  if (!imageCropPointer) return;
  const deltaX = event.clientX - imageCropPointer.startX;
  const deltaY = event.clientY - imageCropPointer.startY;
  if (imageCropPointer.mode === "move") {
    imageCropDisplayRegion.x = Math.min(Math.max(imageCropPointer.region.x + deltaX, imageCropImageBounds.x), imageCropImageBounds.x + imageCropImageBounds.width - imageCropPointer.region.width);
    imageCropDisplayRegion.y = Math.min(Math.max(imageCropPointer.region.y + deltaY, imageCropImageBounds.y), imageCropImageBounds.y + imageCropImageBounds.height - imageCropPointer.region.height);
  } else {
    const maximumWidth = imageCropImageBounds.x + imageCropImageBounds.width - imageCropPointer.region.x;
    const maximumHeight = imageCropImageBounds.y + imageCropImageBounds.height - imageCropPointer.region.y;
    if (imageCropAspectLock.checked) {
      resizeLockedImageCrop(imageCropPointer.handle, deltaX, deltaY);
    } else if (imageCropPointer.handle === "corner") {
      imageCropDisplayRegion.width = Math.max(24, Math.min(imageCropPointer.region.width + deltaX, maximumWidth));
      imageCropDisplayRegion.height = Math.max(24, Math.min(imageCropPointer.region.height + deltaY, maximumHeight));
    } else if (imageCropPointer.handle === "x") imageCropDisplayRegion.width = Math.max(24, Math.min(imageCropPointer.region.width + deltaX, maximumWidth));
    else imageCropDisplayRegion.height = Math.max(24, Math.min(imageCropPointer.region.height + deltaY, maximumHeight));
  }
  updateImageCropResolutionPlaceholders();
  renderImageCropSelection();
});
imageCropStage.addEventListener("pointerup", () => { imageCropPointer = null; });
imageCropWidthInput.addEventListener("input", () => updateLockedImageCropResolution("width"));
imageCropHeightInput.addEventListener("input", () => updateLockedImageCropResolution("height"));
imageCropAspectLock.addEventListener("change", setImageCropAspectLock);
void appWindow.onDragDropEvent((event) => {
  if (event.payload.type === "drop") void addSourcePaths(event.payload.paths);
});
void listen<Result>("conversion-progress", ({ payload }) => {
  taskResults.set(payload.sourcePath, payload);
  renderTaskQueue();
});
renderFormats();
renderVideoFormats();
setActiveFormatCategory(activeFormatCategory);
renderCompressionMode();
renderFiles();
void checkForNewVersion();

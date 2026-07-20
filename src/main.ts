import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type Format = "jpeg" | "png" | "webp" | "bmp" | "tiff" | "ico" | "avif" | "heic";
type Result = { sourcePath: string; outputPath?: string; outputSize?: number; status: "completed" | "failed"; message?: string };
type Dimensions = [number, number];
type CropRegion = { x: number; y: number; width: number; height: number };
type OutputDimensions = { width: number; height: number };
type CompressionMode = "lossy" | "lossless";

const formats: Record<Format, string> = { jpeg: "JPG", png: "PNG", webp: "WebP", bmp: "BMP", tiff: "TIFF", ico: "ICO", avif: "AVIF", heic: "HEIC" };
let sourcePaths: string[] = [];
let outputDirectory = "";

const byId = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const fileList = byId<HTMLDivElement>("file-list");
const qualityInput = byId<HTMLInputElement>("quality-input");
const compressionMode = byId<HTMLDivElement>("compression-mode");
const convertButton = byId<HTMLButtonElement>("convert-button");
const statusMessage = byId<HTMLButtonElement>("status-message");
const formatNav = byId<HTMLElement>("format-nav");
const formatSectionToggle = byId<HTMLButtonElement>("format-section-toggle");
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
const icoSizeOptions = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="ico-size"]'));
let targetFormat: Format = "jpeg";
let selectedCompressionMode: CompressionMode = "lossy";
let isFormatSectionExpanded = true;
const fileSizes = new Map<string, number>();
const imageDimensions = new Map<string, Dimensions>();
const icoCropRegions = new Map<string, CropRegion>();
const outputDimensions = new Map<string, OutputDimensions>();
const taskResults = new Map<string, Result>();
let isConverting = false;
let statusScrollFrame: number | undefined;
let icoCropQueue: string[] = [];
let icoCropIndex = 0;
let formatBeforeIco: Format = "jpeg";
let icoSize = 256;
let icoCropDisplayRegion = { x: 0, y: 0, width: 0, height: 0 };
let icoCropImageBounds = { x: 0, y: 0, width: 0, height: 0 };
let icoCropPointer: { startX: number; startY: number; region: typeof icoCropDisplayRegion } | null = null;
let imageCropPath: string | null = null;
let imageCropDisplayRegion = { x: 0, y: 0, width: 0, height: 0 };
let imageCropImageBounds = { x: 0, y: 0, width: 0, height: 0 };
let imageCropPointer: { mode: "move" | "resize"; handle: "x" | "y" | "corner" | null; startX: number; startY: number; region: typeof imageCropDisplayRegion } | null = null;

function formatFileSize(bytes?: number) {
  if (bytes === undefined) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      const state = result ? (result.status === "completed" ? "完成" : "失败") : isConverting && index === completed ? "转换中" : "等待";
      const details = result?.status === "completed"
        ? `${formats[targetFormat]} · ${formatFileSize(fileSizes.get(path))} &#8594; ${formatFileSize(result.outputSize)}`
        : formats[targetFormat];
      return `<div class="task-queue-row"><span class="queue-thumbnail"><img src="${convertFileSrc(path)}" alt="" /></span><span class="queue-file"><span>${name}</span><small>${details}</small></span><span class="queue-state ${result?.status ?? (state === "转换中" ? "converting" : "pending")}">${state}</span></div>`;
    }).join("")
    : '<p class="task-queue-empty">暂无任务</p>';
}

function renderFiles(results: Result[] = []) {
  const resultByPath = new Map(results.map((result) => [result.sourcePath, result]));
  fileList.classList.toggle("is-empty", sourcePaths.length === 0);
  const fileRows = sourcePaths.map((path, index) => {
    const result = resultByPath.get(path);
    const name = path.split(/[\\/]/).pop() ?? path;
    const state = result ? (result.status === "completed" ? "完成" : result.message ?? "失败") : "待处理";
    return `<div class="file-row"><span class="file-thumbnail"><img src="${convertFileSrc(path)}" alt="" /></span><span class="file-name">${name}</span><span class="file-state ${result?.status ?? "pending"}">${state}</span><span class="file-size">${formatFileSize(fileSizes.get(path))}</span><button class="crop-file-button" type="button" data-file-index="${index}" title="裁剪图片" aria-label="裁剪 ${name}">裁剪</button><button class="remove-file-button" type="button" data-file-index="${index}" title="移除文件" aria-label="移除 ${name}">&times;</button></div>`;
  }).join("");
  fileList.innerHTML = fileRows
    ? `${fileRows}<button class="add-file-button" type="button"><span aria-hidden="true">+</span>添加文件</button>`
    : '<button class="empty-state" type="button"><span>打开</span>/拖入文件</button>';
  byId("file-count").textContent = String(sourcePaths.length);
  convertButton.disabled = !sourcePaths.length;
  renderExportControl();
  renderTaskQueue();
}

async function addSourcePaths(paths: string[]) {
  const addedPaths = paths.filter((path) => !sourcePaths.includes(path));
  sourcePaths = [...new Set([...sourcePaths, ...paths])];
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
  if (targetFormat === "ico") void startIcoCropping();
}

async function addFiles() {
  const selected = await open({ multiple: true, directory: false, filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif", "ico", "avif", "heic", "heif"] }] });
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
  if (!sourcePaths.length) return;
  if (!outputDirectory) {
    await chooseOutputDirectory();
    return;
  }
  if (targetFormat === "ico" && await startIcoCropping()) return;
  convertButton.disabled = true;
  isConverting = true;
  taskResults.clear();
  renderTaskQueue();
  statusMessage.textContent = "转换中，点击打开日志文件夹";
  const cropRegions = Object.fromEntries(icoCropRegions);
  const results = await invoke<Result[]>("convert_images", { request: { sourcePaths, outputDirectory, targetFormat, quality: Number(qualityInput.value), compressionMode: selectedCompressionMode, cropRegions, outputDimensions: Object.fromEntries(outputDimensions), icoSize } });
  isConverting = false;
  results.forEach((result) => taskResults.set(result.sourcePath, result));
  renderFiles(results);
  const completed = results.filter((result) => result.status === "completed").length;
  statusMessage.textContent = `已完成 ${completed}/${results.length}，点击打开日志文件夹`;
}

function renderFormats() {
  formatNav.innerHTML = Object.entries(formats).map(([value, label]) =>
    `<button class="format-button ${value === targetFormat ? "is-active" : ""}" data-format="${value}">${label}</button>`
  ).join("");
}

function renderCompressionMode() {
  const isSupported = targetFormat === "webp";
  compressionMode.classList.toggle("is-disabled", !isSupported);
  compressionMode.classList.toggle("is-lossless", selectedCompressionMode === "lossless");
  qualityInput.disabled = isSupported && selectedCompressionMode === "lossless";
  compressionMode.querySelectorAll<HTMLButtonElement>("[data-compression-mode]").forEach((button) => {
    button.disabled = !isSupported;
    button.classList.toggle("is-active", button.dataset.compressionMode === selectedCompressionMode);
  });
}

function setFormatSectionExpanded(isExpanded: boolean) {
  isFormatSectionExpanded = isExpanded;
  formatSectionToggle.setAttribute("aria-expanded", String(isExpanded));
  formatNav.classList.toggle("is-collapsed", !isExpanded);
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

function updateImageCropResolution() {
  const dimensions = currentImageCropDimensions();
  if (!dimensions) return;
  imageCropWidthInput.placeholder = String(dimensions.width);
  imageCropHeightInput.placeholder = String(dimensions.height);
  const requestedWidth = Number(imageCropWidthInput.value);
  if (requestedWidth > 0) imageCropHeightInput.value = String(Math.max(1, Math.round(requestedWidth * dimensions.height / dimensions.width)));
}

async function startFileCropping(path: string) {
  if (imageCropDialog.open || !imageDimensions.has(path)) return;
  imageCropPath = path;
  imageCropDialog.showModal();
  imageCropImage.src = convertFileSrc(path);
  await new Promise<void>((resolve, reject) => {
    imageCropImage.onload = () => resolve();
    imageCropImage.onerror = () => reject(new Error("无法加载待裁剪图片"));
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
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

qualityInput.addEventListener("input", () => byId("quality-value").textContent = qualityInput.value);
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
formatSectionToggle.addEventListener("click", () => {
  setFormatSectionExpanded(!isFormatSectionExpanded);
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
      const directory = await invoke<string>("log_directory");
      const result = await openPath(directory);
      statusMessage.textContent = result === null ? "已打开日志文件夹" : `无法打开日志文件夹：${result}`;
    } catch (error) {
      statusMessage.textContent = `无法打开日志文件夹：${String(error)}`;
    }
  })();
});
statusMessage.addEventListener("mouseenter", startStatusScroll);
statusMessage.addEventListener("mouseleave", stopStatusScroll);
byId("clear-button").addEventListener("click", () => {
  sourcePaths = [];
  fileSizes.clear();
  imageDimensions.clear();
  icoCropRegions.clear();
  outputDimensions.clear();
  renderFiles();
});
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
  icoCropPointer = { startX: event.clientX, startY: event.clientY, region: { ...icoCropDisplayRegion } };
  icoCropStage.setPointerCapture(event.pointerId);
});
icoCropStage.addEventListener("pointermove", (event) => {
  if (!icoCropPointer) return;
  const delta = Math.max(event.clientX - icoCropPointer.startX, event.clientY - icoCropPointer.startY);
  const maximumSize = Math.min(icoCropImageBounds.x + icoCropImageBounds.width - icoCropPointer.region.x, icoCropImageBounds.y + icoCropImageBounds.height - icoCropPointer.region.y);
  const size = Math.max(24, Math.min(icoCropPointer.region.width + delta, maximumSize));
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
    if (imageCropPointer.handle === "corner") {
      imageCropDisplayRegion.width = Math.max(24, Math.min(imageCropPointer.region.width + deltaX, maximumWidth));
      imageCropDisplayRegion.height = Math.max(24, Math.min(imageCropPointer.region.height + deltaY, maximumHeight));
    } else if (imageCropPointer.handle === "x") imageCropDisplayRegion.width = Math.max(24, Math.min(imageCropPointer.region.width + deltaX, maximumWidth));
    else imageCropDisplayRegion.height = Math.max(24, Math.min(imageCropPointer.region.height + deltaY, maximumHeight));
  }
  updateImageCropResolution();
  renderImageCropSelection();
});
imageCropStage.addEventListener("pointerup", () => { imageCropPointer = null; });
imageCropWidthInput.addEventListener("input", updateImageCropResolution);
imageCropHeightInput.addEventListener("input", () => {
  const dimensions = currentImageCropDimensions();
  const requestedHeight = Number(imageCropHeightInput.value);
  if (dimensions && requestedHeight > 0) imageCropWidthInput.value = String(Math.max(1, Math.round(requestedHeight * dimensions.width / dimensions.height)));
});
void getCurrentWebviewWindow().onDragDropEvent((event) => {
  if (event.payload.type === "drop") void addSourcePaths(event.payload.paths);
});
void listen<Result>("conversion-progress", ({ payload }) => {
  taskResults.set(payload.sourcePath, payload);
  renderTaskQueue();
});
renderFormats();
renderCompressionMode();
renderFiles();

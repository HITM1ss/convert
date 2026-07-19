import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type Format = "jpeg" | "png" | "webp" | "bmp" | "tiff" | "ico" | "avif" | "heic";
type Result = { sourcePath: string; outputPath?: string; outputSize?: number; status: "completed" | "failed"; message?: string };
type Dimensions = [number, number];
type CropRegion = { x: number; y: number; width: number; height: number };
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
const icoSizeOptions = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="ico-size"]'));
let targetFormat: Format = "jpeg";
let selectedCompressionMode: CompressionMode = "lossy";
let isFormatSectionExpanded = true;
const fileSizes = new Map<string, number>();
const imageDimensions = new Map<string, Dimensions>();
const icoCropRegions = new Map<string, CropRegion>();
const taskResults = new Map<string, Result>();
let isConverting = false;
let statusScrollFrame: number | undefined;
let icoCropQueue: string[] = [];
let icoCropIndex = 0;
let formatBeforeIco: Format = "jpeg";
let icoSize = 256;
let cropDisplayRegion = { x: 0, y: 0, width: 0, height: 0 };
let cropImageBounds = { x: 0, y: 0, width: 0, height: 0 };
let cropPointer: { mode: "move" | "resize"; startX: number; startY: number; region: typeof cropDisplayRegion } | null = null;

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
    return `<div class="file-row"><span class="file-thumbnail"><img src="${convertFileSrc(path)}" alt="" /></span><span class="file-name">${name}</span><span class="file-state ${result?.status ?? "pending"}">${state}</span><span class="file-size">${formatFileSize(fileSizes.get(path))}</span><button class="remove-file-button" type="button" data-file-index="${index}" title="移除文件" aria-label="移除 ${name}">&times;</button></div>`;
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
  const results = await invoke<Result[]>("convert_images", { request: { sourcePaths, outputDirectory, targetFormat, quality: Number(qualityInput.value), compressionMode: selectedCompressionMode, cropRegions, icoSize } });
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
  const dimensions = imageDimensions.get(path);
  return dimensions !== undefined && dimensions[0] !== dimensions[1] && !icoCropRegions.has(path);
}

async function startIcoCropping() {
  if (icoCropDialog.open) return true;
  icoCropQueue = sourcePaths.filter(isIcoCropRequired);
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
  const [width, height] = imageDimensions.get(path)!;
  byId("ico-crop-file").textContent = `${path.split(/[\\/]/).pop() ?? path} · ${width} × ${height}`;
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
  cropImageBounds = {
    x: imageBounds.left - stageBounds.left,
    y: imageBounds.top - stageBounds.top,
    width: imageBounds.width,
    height: imageBounds.height,
  };
  const size = Math.min(cropImageBounds.width, cropImageBounds.height) * 0.8;
  cropDisplayRegion = {
    x: cropImageBounds.x + (cropImageBounds.width - size) / 2,
    y: cropImageBounds.y + (cropImageBounds.height - size) / 2,
    width: size,
    height: size,
  };
  renderCropSelection();
}

function renderCropSelection() {
  icoCropSelection.style.left = `${cropDisplayRegion.x}px`;
  icoCropSelection.style.top = `${cropDisplayRegion.y}px`;
  icoCropSelection.style.width = `${cropDisplayRegion.width}px`;
  icoCropSelection.style.height = `${cropDisplayRegion.height}px`;
}

function saveCurrentIcoCrop() {
  const path = icoCropQueue[icoCropIndex];
  const [width, height] = imageDimensions.get(path)!;
  const scaleX = width / cropImageBounds.width;
  const scaleY = height / cropImageBounds.height;
  const x = Math.max(0, Math.min(Math.round((cropDisplayRegion.x - cropImageBounds.x) * scaleX), width - 1));
  const y = Math.max(0, Math.min(Math.round((cropDisplayRegion.y - cropImageBounds.y) * scaleY), height - 1));
  const size = Math.max(1, Math.min(
    Math.round(cropDisplayRegion.width * scaleX),
    Math.round(cropDisplayRegion.height * scaleY),
    width - x,
    height - y,
  ));
  icoCropRegions.set(path, {
    x,
    y,
    width: size,
    height: size,
  });
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
  const removeButton = (event.target as HTMLElement).closest<HTMLButtonElement>(".remove-file-button");
  if (!removeButton) return;
  const [removedPath] = sourcePaths.splice(Number(removeButton.dataset.fileIndex), 1);
  fileSizes.delete(removedPath);
  imageDimensions.delete(removedPath);
  icoCropRegions.delete(removedPath);
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
  renderFiles();
});
icoCropConfirm.addEventListener("click", () => {
  saveCurrentIcoCrop();
  icoCropIndex += 1;
  void showNextIcoCrop();
});
byId("ico-crop-cancel").addEventListener("click", cancelIcoCropping);
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
  if (!icoCropDialog.open) return;
  const target = event.target as HTMLElement;
  const handle = target.closest(".crop-handle");
  if (target !== icoCropSelection && !handle) return;
  const mode = handle ? "resize" : "move";
  cropPointer = { mode, startX: event.clientX, startY: event.clientY, region: { ...cropDisplayRegion } };
  icoCropStage.setPointerCapture(event.pointerId);
});
icoCropStage.addEventListener("pointermove", (event) => {
  if (!cropPointer) return;
  const deltaX = event.clientX - cropPointer.startX;
  const deltaY = event.clientY - cropPointer.startY;
  if (cropPointer.mode === "move") {
    cropDisplayRegion.x = Math.min(Math.max(cropPointer.region.x + deltaX, cropImageBounds.x), cropImageBounds.x + cropImageBounds.width - cropPointer.region.width);
    cropDisplayRegion.y = Math.min(Math.max(cropPointer.region.y + deltaY, cropImageBounds.y), cropImageBounds.y + cropImageBounds.height - cropPointer.region.height);
  } else {
    const requestedSize = cropPointer.region.width + Math.max(deltaX, deltaY);
    const availableSize = Math.min(
      cropImageBounds.x + cropImageBounds.width - cropPointer.region.x,
      cropImageBounds.y + cropImageBounds.height - cropPointer.region.y,
    );
    const size = Math.max(24, Math.min(requestedSize, availableSize));
    cropDisplayRegion.width = size;
    cropDisplayRegion.height = size;
  }
  renderCropSelection();
});
icoCropStage.addEventListener("pointerup", () => { cropPointer = null; });
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

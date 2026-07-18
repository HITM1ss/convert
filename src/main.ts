import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

type Format = "jpeg" | "png" | "webp" | "bmp" | "tiff" | "ico" | "avif";
type Result = { sourcePath: string; outputPath?: string; outputSize?: number; status: "completed" | "failed"; message?: string };

const formats: Record<Format, string> = { jpeg: "JPG", png: "PNG", webp: "WebP", bmp: "BMP", tiff: "TIFF", ico: "ICO", avif: "AVIF" };
let sourcePaths: string[] = [];
let outputDirectory = "";

const byId = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;
const fileList = byId<HTMLDivElement>("file-list");
const qualityInput = byId<HTMLInputElement>("quality-input");
const convertButton = byId<HTMLButtonElement>("convert-button");
const statusMessage = byId<HTMLButtonElement>("status-message");
const formatNav = byId<HTMLElement>("format-nav");
const formatSectionToggle = byId<HTMLButtonElement>("format-section-toggle");
let targetFormat: Format = "jpeg";
let isFormatSectionExpanded = true;
const fileSizes = new Map<string, number>();
const taskResults = new Map<string, Result>();
let isConverting = false;

function formatFileSize(bytes?: number) {
  if (bytes === undefined) return "--";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
      const details = result?.status === "completed" ? `${formats[targetFormat]} · ${formatFileSize(result.outputSize)}` : formats[targetFormat];
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
  addedPaths.forEach((path, index) => {
    const size = sizes[index];
    if (size !== null) fileSizes.set(path, size);
  });
  renderFiles();
}

async function addFiles() {
  const selected = await open({ multiple: true, directory: false, filters: [{ name: "图片", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif", "ico", "avif"] }] });
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
  convertButton.disabled = true;
  isConverting = true;
  taskResults.clear();
  renderTaskQueue();
  statusMessage.textContent = "转换中，点击打开日志文件夹";
  const results = await invoke<Result[]>("convert_images", { request: { sourcePaths, outputDirectory, targetFormat, quality: Number(qualityInput.value) } });
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

function setFormatSectionExpanded(isExpanded: boolean) {
  isFormatSectionExpanded = isExpanded;
  formatSectionToggle.setAttribute("aria-expanded", String(isExpanded));
  formatNav.classList.toggle("is-collapsed", !isExpanded);
}

qualityInput.addEventListener("input", () => byId("quality-value").textContent = qualityInput.value);
formatNav.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-format]");
  if (!button) return;
  targetFormat = button.dataset.format as Format;
  renderFormats();
  renderTaskQueue();
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
  renderFiles();
});
fileList.addEventListener("error", (event) => {
  if (event.target instanceof HTMLImageElement) event.target.closest(".file-thumbnail")?.classList.add("is-unavailable");
}, true);
byId("convert-button").addEventListener("click", () => void convert());
statusMessage.addEventListener("click", () => {
  void invoke<string>("log_directory").then((directory) => openPath(directory));
});
byId("clear-button").addEventListener("click", () => { sourcePaths = []; renderFiles(); });
void getCurrentWebviewWindow().onDragDropEvent((event) => {
  if (event.payload.type === "drop") void addSourcePaths(event.payload.paths);
});
void listen<Result>("conversion-progress", ({ payload }) => {
  taskResults.set(payload.sourcePath, payload);
  renderTaskQueue();
});
renderFormats();
renderFiles();

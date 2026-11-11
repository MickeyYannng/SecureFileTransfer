<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex as nobleBytesToHex } from "@noble/hashes/utils.js";
import {
  BINARY_FLAGS,
  BINARY_MESSAGE_TYPES,
  ERROR_CODES,
  PROTOCOL_NAME,
  createControlMessage,
  encodeBinaryFrame,
  hasStringField,
  parseBinaryFrame,
  parseControlMessage,
  serializeControlMessage,
  type FileListEntry,
  type PublicUser,
  type StorageUsage,
} from "@sft/protocol";

type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
type AuthStatus = "unauthenticated" | "authenticating" | "authenticated";
type UploadStatus = "idle" | "hashing" | "initializing" | "uploading" | "verifying" | "cancelling" | "completed" | "cancelled" | "error";
type DownloadStatus = "idle" | "selecting" | "initializing" | "downloading" | "verifying" | "confirming" | "saving" | "cancelling" | "completed" | "cancelled" | "error";

const connectionStatus = ref<ConnectionStatus>("disconnected");
const authStatus = ref<AuthStatus>("unauthenticated");
const connectionId = ref("—");
const lastHeartbeat = ref("—");
const eventLog = ref<string[]>([]);
const authError = ref("");
const currentUser = ref<PublicUser>();
const sessionExpiresAt = ref<number>();
const loginForm = reactive({ username: "", password: "" });
const currentPath = ref("");
const fileEntries = ref<FileListEntry[]>([]);
const storageUsage = ref<StorageUsage>();
const selectedFile = ref<File>();
const uploadStatus = ref<UploadStatus>("idle");
const uploadProgress = ref(0);
const uploadSpeed = ref(0);
const uploadMessage = ref("请选择一个文件");
const uploadTransferId = ref<string>();
let uploadChunkSize = 256 * 1024;
let uploadPersistedOffset = 0;
let uploadStartedAt = 0;
let uploadGeneration = 0;
const downloadStatus = ref<DownloadStatus>("idle");
const downloadProgress = ref(0);
const downloadSpeed = ref(0);
const downloadMessage = ref("点击文件右侧的下载按钮");
const downloadFileName = ref("");
const downloadTransferId = ref<string>();
let downloadFileSize = 0;
let downloadExpectedOffset = 0;
let downloadExpectedSha256 = "";
let downloadStartedAt = 0;
let downloadHasher: ReturnType<typeof sha256.create> | undefined;
let downloadGeneration = 0;
let downloadFinalHandle: FileSystemFileHandle | undefined;
let downloadTemporaryRoot: FileSystemDirectoryHandle | undefined;
let downloadTemporaryHandle: FileSystemFileHandle | undefined;
let downloadTemporaryName = "";
let downloadTemporaryWritable: FileSystemWritableFileStream | undefined;
let fallbackDownloadChunks: BlobPart[] = [];
const FALLBACK_DOWNLOAD_LIMIT = 32 * 1024 * 1024;

let socket: WebSocket | undefined;
let sessionToken: string | undefined;
let reconnectTimer: number | undefined;
let reconnectAttempt = 0;
let intentionallyClosed = false;

const wsUrl = computed(() => {
  const configured = import.meta.env.VITE_WS_URL as string | undefined;
  if (configured) return configured;
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/ws`;
});

const connectionLabel = computed(() => ({
  connecting: "正在连接",
  connected: "长连接正常",
  disconnected: "已断开",
  error: "连接异常",
}[connectionStatus.value]));

const connectionType = computed(() => connectionStatus.value === "connected" ? "success" : connectionStatus.value === "error" ? "danger" : "warning");
const authLabel = computed(() => ({
  unauthenticated: "未认证",
  authenticating: "正在认证",
  authenticated: "已认证",
}[authStatus.value]));
const authType = computed(() => authStatus.value === "authenticated" ? "success" : authStatus.value === "authenticating" ? "warning" : "info");
const quotaPercent = computed(() => {
  if (!storageUsage.value || storageUsage.value.quotaBytes === 0) return 0;
  return Math.min(100, Math.round(storageUsage.value.usedBytes / storageUsage.value.quotaBytes * 100));
});

function connect(): void {
  if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  intentionallyClosed = false;
  connectionStatus.value = "connecting";
  addLog(`连接 ${wsUrl.value}`);
  socket = new WebSocket(wsUrl.value);
  socket.binaryType = "arraybuffer";

  socket.addEventListener("open", () => {
    reconnectAttempt = 0;
    send("HELLO", { protocol: PROTOCOL_NAME, clientName: "sft-vue-client" });
    addLog("WebSocket 已建立，发送 HELLO");
  });

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") {
      void handleDownloadBinary(event.data);
      return;
    }
    try {
      handleMessage(parseControlMessage(event.data));
    } catch (error) {
      connectionStatus.value = "error";
      addLog(`协议解析失败：${error instanceof Error ? error.message : "未知错误"}`);
    }
  });

  socket.addEventListener("close", () => {
    if (["initializing", "uploading", "verifying", "cancelling"].includes(uploadStatus.value)) {
      failUpload("连接中断；Phase 2.2 不支持断点续传，请重新上传");
    }
    if (["initializing", "downloading", "verifying", "confirming", "saving", "cancelling"].includes(downloadStatus.value)) {
      void failDownload("连接中断；Phase 2.3 不支持断点续传，请重新下载");
    }
    connectionStatus.value = "disconnected";
    authStatus.value = sessionToken ? "authenticating" : "unauthenticated";
    connectionId.value = "—";
    addLog("连接已关闭");
    socket = undefined;
    if (!intentionallyClosed) scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    connectionStatus.value = "error";
    addLog("WebSocket 连接错误");
  });
}

function handleMessage(message: ReturnType<typeof parseControlMessage>): void {
  if (message.type === "HELLO_ACK" && hasStringField(message.payload, "connectionId")) {
    connectionId.value = message.payload.connectionId;
    connectionStatus.value = "connected";
    addLog("应用层协议协商完成");
    if (sessionToken) {
      authStatus.value = "authenticating";
      send("AUTH_TOKEN", { token: sessionToken });
      addLog("重连后重新验证会话令牌");
    } else {
      authStatus.value = "unauthenticated";
    }
    return;
  }
  if (message.type === "HEARTBEAT_PING" && hasStringField(message.payload, "nonce")) {
    send("HEARTBEAT_PONG", { nonce: message.payload.nonce }, message.requestId);
    lastHeartbeat.value = new Date().toLocaleTimeString();
    return;
  }
  if (message.type === "AUTH_SUCCESS") {
    const payload = asRecord(message.payload);
    const user = parsePublicUser(payload.user);
    const expiresAt = readNumber(payload, "expiresAt");
    if (typeof payload.token === "string") sessionToken = payload.token;
    currentUser.value = user;
    sessionExpiresAt.value = expiresAt;
    authStatus.value = "authenticated";
    authError.value = "";
    loginForm.password = "";
    addLog(`用户 ${user.username} 认证成功`);
    send("AUTH_ME", {});
    refreshFiles();
    return;
  }
  if (message.type === "AUTH_ME_RESULT") {
    const payload = asRecord(message.payload);
    currentUser.value = parsePublicUser(payload.user);
    sessionExpiresAt.value = readNumber(payload, "expiresAt");
    return;
  }
  if (message.type === "AUTH_LOGOUT_ACK") {
    clearAuthentication();
    addLog("会话已退出并撤销");
    return;
  }
  if (message.type === "FILE_LIST_RESULT") {
    const payload = asRecord(message.payload);
    currentPath.value = readString(payload, "path");
    fileEntries.value = parseFileEntries(payload.entries);
    storageUsage.value = parseStorageUsage(payload.usage);
    return;
  }
  if (message.type === "UPLOAD_READY") {
    const payload = asRecord(message.payload);
    uploadTransferId.value = readString(payload, "transferId");
    uploadChunkSize = readNumber(payload, "chunkSize");
    uploadPersistedOffset = readNumber(payload, "nextOffset");
    uploadStartedAt = performance.now();
    uploadStatus.value = "uploading";
    uploadMessage.value = "服务器已创建临时文件，正在上传";
    void sendNextUploadChunk(uploadGeneration);
    return;
  }
  if (message.type === "UPLOAD_ACK") {
    const payload = asRecord(message.payload);
    if (readString(payload, "transferId") !== uploadTransferId.value) return;
    const persistedOffset = readNumber(payload, "persistedOffset");
    if (persistedOffset < uploadPersistedOffset || persistedOffset > (selectedFile.value?.size ?? 0)) {
      failUpload("服务器返回了非法 ACK 偏移量");
      return;
    }
    uploadPersistedOffset = persistedOffset;
    updateUploadMetrics();
    if (selectedFile.value && persistedOffset === selectedFile.value.size) {
      uploadStatus.value = "verifying";
      uploadMessage.value = "服务器正在校验整文件 SHA-256 并原子提交";
      send("UPLOAD_FINISH", { transferId: uploadTransferId.value });
    } else {
      void sendNextUploadChunk(uploadGeneration);
    }
    return;
  }
  if (message.type === "UPLOAD_COMPLETE") {
    uploadProgress.value = 100;
    uploadStatus.value = "completed";
    uploadMessage.value = "上传完成，文件已通过完整性校验";
    uploadTransferId.value = undefined;
    addLog("文件上传完成，WebSocket 连接保持正常");
    refreshFiles();
    return;
  }
  if (message.type === "UPLOAD_ABORTED") {
    uploadStatus.value = "cancelled";
    uploadMessage.value = "上传已取消，临时文件已清理";
    uploadTransferId.value = undefined;
    return;
  }
  if (message.type === "UPLOAD_ERROR") {
    const payload = asRecord(message.payload);
    const code = readString(payload, "code");
    failUpload(`${code}：${readString(payload, "message")}`);
    if (code.startsWith("200")) clearAuthentication();
    return;
  }
  if (message.type === "DOWNLOAD_READY") {
    const payload = asRecord(message.payload);
    downloadTransferId.value = readString(payload, "transferId");
    downloadFileName.value = readString(payload, "fileName");
    downloadFileSize = readNumber(payload, "fileSize");
    downloadExpectedSha256 = readString(payload, "fileSha256");
    downloadExpectedOffset = readNumber(payload, "nextOffset");
    downloadStartedAt = performance.now();
    downloadHasher = sha256.create();
    downloadStatus.value = "downloading";
    downloadMessage.value = `正在接收 ${downloadFileName.value} · ${formatBytes(downloadFileSize)}`;
    return;
  }
  if (message.type === "DOWNLOAD_FINISH") {
    void handleDownloadFinish(message.payload);
    return;
  }
  if (message.type === "DOWNLOAD_COMPLETE") {
    const payload = asRecord(message.payload);
    if (payload.accepted === true) void deliverVerifiedDownload();
    return;
  }
  if (message.type === "DOWNLOAD_ABORT") {
    const payload = asRecord(message.payload);
    if (payload.acknowledged === true) {
      downloadStatus.value = "cancelled";
      downloadMessage.value = "下载已取消，临时内容已清理";
      downloadTransferId.value = undefined;
      void cleanupDownloadTarget();
    }
    return;
  }
  if (message.type === "DOWNLOAD_ERROR") {
    const payload = asRecord(message.payload);
    const code = readString(payload, "code");
    void failDownload(`${code}：${readString(payload, "message")}`);
    if (code.startsWith("200")) clearAuthentication();
    return;
  }
  if (message.type === "ERROR") handleServerError(message.payload);
}

async function startDownload(entry: FileListEntry): Promise<void> {
  if (entry.type !== "file" || authStatus.value !== "authenticated" || connectionStatus.value !== "connected") return;
  if (isDownloadActive()) return;
  resetDownloadState();
  const generation = ++downloadGeneration;
  downloadFileName.value = entry.name;
  downloadStatus.value = "selecting";
  downloadMessage.value = `${formatBytes(entry.size)} · 请选择本地保存位置`;
  try {
    const picker = (window as unknown as {
      showSaveFilePicker?: (options: { suggestedName: string }) => Promise<FileSystemFileHandle>;
    }).showSaveFilePicker;
    const getDirectory = navigator.storage?.getDirectory?.bind(navigator.storage);
    if (picker && getDirectory) {
      downloadFinalHandle = await picker({ suggestedName: entry.name });
      if (generation !== downloadGeneration) return;
      downloadTemporaryRoot = await getDirectory();
      downloadTemporaryName = `.sft-${crypto.randomUUID()}.part`;
      downloadTemporaryHandle = await downloadTemporaryRoot.getFileHandle(downloadTemporaryName, { create: true });
      downloadTemporaryWritable = await downloadTemporaryHandle.createWritable();
    } else {
      if (entry.size > FALLBACK_DOWNLOAD_LIMIT) {
        throw new Error("当前浏览器不支持流式保存；兼容模式最多下载 32 MiB，请使用最新版 Edge 或 Chrome");
      }
      fallbackDownloadChunks = [];
    }
    if (generation !== downloadGeneration) return;
    const logicalPath = currentPath.value ? `${currentPath.value}/${entry.name}` : entry.name;
    downloadStatus.value = "initializing";
    downloadMessage.value = "服务器正在验证权限并计算源文件摘要";
    send("DOWNLOAD_INIT", { path: logicalPath });
  } catch (error) {
    if (isAbortError(error)) {
      downloadStatus.value = "cancelled";
      downloadMessage.value = "用户取消了保存位置选择";
      return;
    }
    await failDownload(error instanceof Error ? error.message : "无法准备下载目标");
  }
}

async function handleDownloadBinary(data: Blob | ArrayBuffer): Promise<void> {
  if (downloadStatus.value !== "downloading" || !downloadTransferId.value || !downloadHasher) {
    addLog("收到不属于活动下载任务的二进制帧");
    return;
  }
  const generation = downloadGeneration;
  try {
    const bytes = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
    const frame = parseBinaryFrame(bytes, 1024 * 1024);
    if (frame.header.messageType !== BINARY_MESSAGE_TYPES.downloadChunk
      || frame.header.transferId !== downloadTransferId.value
      || frame.header.errorCode !== 0
      || frame.header.metadataLength !== 0
      || (frame.header.flags & BINARY_FLAGS.ackRequired) === 0
      || frame.header.fileSize !== BigInt(downloadFileSize)
      || frame.header.offset !== BigInt(downloadExpectedOffset)
      || frame.payload.byteLength === 0
      || downloadExpectedOffset + frame.payload.byteLength > downloadFileSize
      || !equalBytes(sha256(frame.payload), frame.header.payloadSha256)) {
      throw new Error("服务器下载分块的类型、偏移、长度或 SHA-256 无效");
    }
    if (downloadTemporaryWritable) {
      await downloadTemporaryWritable.write(new Uint8Array(frame.payload).buffer as ArrayBuffer);
    } else {
      if (downloadExpectedOffset + frame.payload.byteLength > FALLBACK_DOWNLOAD_LIMIT) {
        throw new Error("兼容模式下载超过 32 MiB 内存限制");
      }
      fallbackDownloadChunks.push(new Uint8Array(frame.payload).buffer as ArrayBuffer);
    }
    if (generation !== downloadGeneration) return;
    downloadHasher.update(frame.payload);
    downloadExpectedOffset += frame.payload.byteLength;
    updateDownloadMetrics();
    send("DOWNLOAD_ACK", { transferId: downloadTransferId.value, nextOffset: downloadExpectedOffset });
  } catch (error) {
    const transferId = downloadTransferId.value;
    if (transferId && socket?.readyState === WebSocket.OPEN) send("DOWNLOAD_ABORT", { transferId });
    await failDownload(error instanceof Error ? error.message : "接收下载分块失败");
  }
}

async function handleDownloadFinish(value: unknown): Promise<void> {
  if (!downloadTransferId.value || !downloadHasher || downloadStatus.value !== "downloading") return;
  const payload = asRecord(value);
  const transferId = readString(payload, "transferId");
  const fileSize = readNumber(payload, "fileSize");
  const fileSha256 = readString(payload, "fileSha256");
  if (transferId !== downloadTransferId.value) return;
  downloadStatus.value = "verifying";
  downloadMessage.value = "正在验证整文件 SHA-256";
  const actualSha256 = nobleBytesToHex(downloadHasher.digest());
  downloadHasher = undefined;
  const success = downloadExpectedOffset === downloadFileSize
    && fileSize === downloadFileSize
    && fileSha256 === downloadExpectedSha256
    && actualSha256 === downloadExpectedSha256;
  if (downloadTemporaryWritable) {
    await downloadTemporaryWritable.close();
    downloadTemporaryWritable = undefined;
  }
  if (!success) {
    send("DOWNLOAD_COMPLETE", {
      transferId, success: false, receivedSize: downloadExpectedOffset, fileSha256: actualSha256,
    });
    await failDownload("整文件大小或 SHA-256 校验失败，文件不会交付");
    return;
  }
  downloadStatus.value = "confirming";
  downloadMessage.value = "完整性验证通过，等待服务器确认任务完成";
  send("DOWNLOAD_COMPLETE", {
    transferId, success: true, receivedSize: downloadExpectedOffset, fileSha256: actualSha256,
  });
}

async function deliverVerifiedDownload(): Promise<void> {
  downloadStatus.value = "saving";
  downloadMessage.value = "校验通过，正在交付文件";
  try {
    if (downloadFinalHandle && downloadTemporaryHandle) {
      const source = await downloadTemporaryHandle.getFile();
      const reader = source.stream().getReader();
      const destination = await downloadFinalHandle.createWritable();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await destination.write(value);
        }
        await destination.close();
      } catch (error) {
        await destination.abort().catch(() => undefined);
        throw error;
      } finally {
        reader.releaseLock();
      }
    } else {
      const blob = new Blob(fallbackDownloadChunks, { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = downloadFileName.value;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
    }
    downloadProgress.value = 100;
    downloadStatus.value = "completed";
    downloadMessage.value = "下载完成，文件已通过 SHA-256 校验";
    downloadTransferId.value = undefined;
    addLog("文件下载完成，WebSocket 连接保持正常");
    await cleanupDownloadTarget();
  } catch (error) {
    await failDownload(error instanceof Error ? error.message : "保存已验证文件失败");
  }
}

function cancelDownload(): void {
  downloadGeneration += 1;
  const transferId = downloadTransferId.value;
  if (transferId && socket?.readyState === WebSocket.OPEN) {
    downloadStatus.value = "cancelling";
    downloadMessage.value = "正在取消下载并清理临时内容";
    send("DOWNLOAD_ABORT", { transferId });
  } else {
    downloadStatus.value = "cancelled";
    downloadMessage.value = "下载已取消";
    void cleanupDownloadTarget();
  }
}

function updateDownloadMetrics(): void {
  downloadProgress.value = downloadFileSize === 0 ? 100 : Math.round(downloadExpectedOffset / downloadFileSize * 100);
  const elapsedSeconds = Math.max((performance.now() - downloadStartedAt) / 1000, 0.001);
  downloadSpeed.value = downloadExpectedOffset / elapsedSeconds;
  downloadMessage.value = `${formatBytes(downloadExpectedOffset)} / ${formatBytes(downloadFileSize)}`;
}

function isDownloadActive(): boolean {
  return ["selecting", "initializing", "downloading", "verifying", "confirming", "saving", "cancelling"].includes(downloadStatus.value);
}

function isDownloadCancelable(): boolean {
  return ["selecting", "initializing", "downloading", "verifying", "confirming"].includes(downloadStatus.value);
}

function resetDownloadState(): void {
  downloadGeneration += 1;
  downloadStatus.value = "idle";
  downloadProgress.value = 0;
  downloadSpeed.value = 0;
  downloadFileSize = 0;
  downloadExpectedOffset = 0;
  downloadExpectedSha256 = "";
  downloadHasher = undefined;
  downloadTransferId.value = undefined;
  fallbackDownloadChunks = [];
}

async function failDownload(message: string): Promise<void> {
  downloadGeneration += 1;
  downloadStatus.value = "error";
  downloadMessage.value = message;
  downloadTransferId.value = undefined;
  downloadHasher = undefined;
  addLog(`下载失败：${message}`);
  await cleanupDownloadTarget();
}

async function cleanupDownloadTarget(): Promise<void> {
  if (downloadTemporaryWritable) {
    await downloadTemporaryWritable.abort().catch(() => undefined);
    downloadTemporaryWritable = undefined;
  }
  if (downloadTemporaryRoot && downloadTemporaryName) {
    await downloadTemporaryRoot.removeEntry(downloadTemporaryName).catch(() => undefined);
  }
  downloadTemporaryRoot = undefined;
  downloadTemporaryHandle = undefined;
  downloadTemporaryName = "";
  downloadFinalHandle = undefined;
  fallbackDownloadChunks = [];
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function selectFile(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  selectedFile.value = file;
  resetUploadState();
  uploadMessage.value = `${file.name} · ${formatBytes(file.size)}`;
}

async function startUpload(): Promise<void> {
  const file = selectedFile.value;
  if (!file || authStatus.value !== "authenticated" || connectionStatus.value !== "connected") return;
  resetUploadState();
  const generation = ++uploadGeneration;
  uploadStatus.value = "hashing";
  uploadMessage.value = "正在分块计算文件 SHA-256";
  try {
    const hasher = sha256.create();
    const hashChunkSize = 1024 * 1024;
    for (let offset = 0; offset < file.size; offset += hashChunkSize) {
      if (generation !== uploadGeneration) return;
      const chunk = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + hashChunkSize)).arrayBuffer());
      hasher.update(chunk);
      uploadProgress.value = file.size === 0 ? 0 : Math.min(20, Math.round((offset + chunk.byteLength) / file.size * 20));
      await nextBrowserTurn();
    }
    if (generation !== uploadGeneration) return;
    const fileSha256 = nobleBytesToHex(hasher.digest());
    const logicalPath = currentPath.value ? `${currentPath.value}/${file.name}` : file.name;
    uploadStatus.value = "initializing";
    uploadProgress.value = 0;
    uploadMessage.value = "正在验证文件名、配额和服务器磁盘空间";
    send("UPLOAD_INIT", { path: logicalPath, fileSize: file.size, fileSha256 });
  } catch (error) {
    failUpload(error instanceof Error ? error.message : "计算文件摘要失败");
  }
}

async function sendNextUploadChunk(generation: number): Promise<void> {
  const file = selectedFile.value;
  const transferId = uploadTransferId.value;
  if (!file || !transferId || generation !== uploadGeneration || uploadStatus.value !== "uploading") return;
  if (uploadPersistedOffset === file.size) {
    uploadStatus.value = "verifying";
    send("UPLOAD_FINISH", { transferId });
    return;
  }
  try {
    const end = Math.min(file.size, uploadPersistedOffset + uploadChunkSize);
    const payload = new Uint8Array(await file.slice(uploadPersistedOffset, end).arrayBuffer());
    if (generation !== uploadGeneration) return;
    const frame = encodeBinaryFrame({
      messageType: BINARY_MESSAGE_TYPES.uploadChunk,
      flags: BINARY_FLAGS.ackRequired,
      errorCode: 0,
      requestId: crypto.randomUUID(),
      transferId,
      fileSize: BigInt(file.size),
      offset: BigInt(uploadPersistedOffset),
      payloadSha256: sha256(payload),
    }, payload);
    if (socket?.readyState !== WebSocket.OPEN) throw new Error("WebSocket 已断开");
    socket.send(frame);
  } catch (error) {
    failUpload(error instanceof Error ? error.message : "读取或发送文件分块失败");
  }
}

function cancelUpload(): void {
  uploadGeneration += 1;
  if (uploadTransferId.value && socket?.readyState === WebSocket.OPEN) {
    uploadStatus.value = "cancelling";
    uploadMessage.value = "正在取消并清理服务器临时文件";
    send("UPLOAD_ABORT", { transferId: uploadTransferId.value });
  } else {
    uploadStatus.value = "cancelled";
    uploadMessage.value = "操作已取消";
  }
}

function updateUploadMetrics(): void {
  const fileSize = selectedFile.value?.size ?? 0;
  uploadProgress.value = fileSize === 0 ? 100 : Math.round(uploadPersistedOffset / fileSize * 100);
  const elapsedSeconds = Math.max((performance.now() - uploadStartedAt) / 1000, 0.001);
  uploadSpeed.value = uploadPersistedOffset / elapsedSeconds;
  uploadMessage.value = `${formatBytes(uploadPersistedOffset)} / ${formatBytes(fileSize)}`;
}

function resetUploadState(): void {
  uploadGeneration += 1;
  uploadStatus.value = "idle";
  uploadProgress.value = 0;
  uploadSpeed.value = 0;
  uploadPersistedOffset = 0;
  uploadTransferId.value = undefined;
}

function failUpload(message: string): void {
  uploadGeneration += 1;
  uploadStatus.value = "error";
  uploadMessage.value = message;
  uploadTransferId.value = undefined;
  addLog(`上传失败：${message}`);
}

function nextBrowserTurn(): Promise<void> {
  return new Promise((resolvePromise) => window.setTimeout(resolvePromise, 0));
}

function login(): void {
  if (connectionStatus.value !== "connected") {
    authError.value = "请先等待服务器连接完成";
    return;
  }
  authError.value = "";
  authStatus.value = "authenticating";
  send("AUTH_LOGIN", { username: loginForm.username, password: loginForm.password });
}

function logout(): void {
  if (authStatus.value === "authenticated") {
    if (["hashing", "initializing", "uploading", "verifying"].includes(uploadStatus.value)) cancelUpload();
    if (isDownloadActive()) cancelDownload();
    send("AUTH_LOGOUT", {});
  }
}

function refreshFiles(): void {
  if (authStatus.value === "authenticated") send("FILE_LIST_REQUEST", { path: currentPath.value });
}

function openDirectory(entry: FileListEntry): void {
  if (entry.type !== "directory") return;
  currentPath.value = currentPath.value ? `${currentPath.value}/${entry.name}` : entry.name;
  refreshFiles();
}

function goUp(): void {
  const parts = currentPath.value.split("/").filter(Boolean);
  parts.pop();
  currentPath.value = parts.join("/");
  refreshFiles();
}

function disconnect(): void {
  intentionallyClosed = true;
  if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
  socket?.close(1000, "user disconnected");
}

function scheduleReconnect(): void {
  const baseDelay = Math.min(1_000 * 2 ** reconnectAttempt, 10_000);
  const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4));
  reconnectAttempt += 1;
  addLog(`${(delay / 1000).toFixed(1)} 秒后重连`);
  reconnectTimer = window.setTimeout(connect, delay);
}

function send(
  type: Parameters<typeof createControlMessage>[0],
  payload: Record<string, unknown>,
  requestId: string = crypto.randomUUID(),
): void {
  if (socket?.readyState !== WebSocket.OPEN) throw new Error("WebSocket is not open");
  socket.send(serializeControlMessage(createControlMessage(type, requestId, payload)));
}

function handleServerError(value: unknown): void {
  const payload = asRecord(value);
  const code = readString(payload, "code");
  const message = readString(payload, "message");
  authError.value = message;
  addLog(`服务器拒绝请求：${code}`);
  if ([
    ERROR_CODES.authRequired,
    ERROR_CODES.invalidCredentials,
    ERROR_CODES.sessionExpired,
    ERROR_CODES.sessionRevoked,
  ].includes(code as never)) {
    clearAuthentication();
  }
}

function clearAuthentication(): void {
  resetUploadState();
  resetDownloadState();
  void cleanupDownloadTarget();
  sessionToken = undefined;
  currentUser.value = undefined;
  sessionExpiresAt.value = undefined;
  authStatus.value = "unauthenticated";
  currentPath.value = "";
  fileEntries.value = [];
  storageUsage.value = undefined;
  loginForm.password = "";
}

function addLog(message: string): void {
  eventLog.value.unshift(`${new Date().toLocaleTimeString()}  ${message}`);
  eventLog.value = eventLog.value.slice(0, 8);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid payload object");
  return value as Record<string, unknown>;
}

function readString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`invalid ${key}`);
  return field;
}

function readNumber(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field)) throw new Error(`invalid ${key}`);
  return field;
}

function parsePublicUser(value: unknown): PublicUser {
  const user = asRecord(value);
  return {
    id: readString(user, "id"),
    username: readString(user, "username"),
    displayName: readString(user, "displayName"),
    role: readString(user, "role"),
    quotaBytes: readNumber(user, "quotaBytes"),
    maxFiles: readNumber(user, "maxFiles"),
  };
}

function parseFileEntries(value: unknown): FileListEntry[] {
  if (!Array.isArray(value)) throw new Error("invalid file entries");
  return value.map((item) => {
    const entry = asRecord(item);
    const type = readString(entry, "type");
    if (type !== "file" && type !== "directory") throw new Error("invalid entry type");
    return {
      name: readString(entry, "name"),
      type,
      size: readNumber(entry, "size"),
      modifiedAt: readNumber(entry, "modifiedAt"),
    };
  });
}

function parseStorageUsage(value: unknown): StorageUsage {
  const usage = asRecord(value);
  return {
    usedBytes: readNumber(usage, "usedBytes"),
    fileCount: readNumber(usage, "fileCount"),
    quotaBytes: readNumber(usage, "quotaBytes"),
    maxFiles: readNumber(usage, "maxFiles"),
    maxFileSizeBytes: readNumber(usage, "maxFileSizeBytes"),
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

onMounted(connect);
onBeforeUnmount(disconnect);
</script>

<template>
  <main class="page-shell">
    <header class="topbar">
      <div>
        <p class="eyebrow">UCAS · 软件与系统安全实验 1B</p>
        <h1>安全文件传输</h1>
      </div>
      <div class="status-stack">
        <el-tag :type="connectionType" effect="dark">{{ connectionLabel }}</el-tag>
        <el-tag :type="authType">{{ authLabel }}</el-tag>
      </div>
    </header>

    <section v-if="authStatus !== 'authenticated'" class="login-layout">
      <div class="login-copy">
        <span class="phase-pill">Phase 2.3</span>
        <h2>先验证身份，再访问私人空间</h2>
        <p>密码通过 WebSocket 自定义协议提交，服务端使用 Argon2id 验证；重连时必须重新验证短期会话令牌。</p>
      </div>
      <el-card class="login-card" shadow="never">
        <template #header><strong>用户登录</strong></template>
        <el-form label-position="top" @submit.prevent="login">
          <el-form-item label="用户名">
            <el-input v-model="loginForm.username" maxlength="128" autocomplete="username" placeholder="Alice 或 Bob" />
          </el-form-item>
          <el-form-item label="密码">
            <el-input v-model="loginForm.password" type="password" maxlength="256" show-password autocomplete="current-password" @keyup.enter="login" />
          </el-form-item>
          <el-alert v-if="authError" :title="authError" type="error" :closable="false" show-icon />
          <el-button class="full-button" type="primary" :loading="authStatus === 'authenticating'" :disabled="connectionStatus !== 'connected'" @click="login">登录</el-button>
        </el-form>
      </el-card>
    </section>

    <template v-else>
      <section class="dashboard-grid">
        <el-card class="profile-card" shadow="never">
          <template #header>
            <div class="card-header"><span>当前用户</span><el-button text type="danger" @click="logout">退出</el-button></div>
          </template>
          <div class="identity-row">
            <div class="avatar">{{ currentUser?.displayName.slice(0, 1).toUpperCase() }}</div>
            <div><strong>{{ currentUser?.displayName }}</strong><p>@{{ currentUser?.username }} · {{ currentUser?.role }}</p></div>
          </div>
          <p class="session-expiry">会话有效至：{{ sessionExpiresAt ? new Date(sessionExpiresAt).toLocaleString() : '—' }}</p>
        </el-card>

        <el-card class="storage-card" shadow="never">
          <template #header><strong>私人存储配额</strong></template>
          <el-progress :percentage="quotaPercent" :stroke-width="10" />
          <p v-if="storageUsage" class="quota-copy">
            {{ formatBytes(storageUsage.usedBytes) }} / {{ formatBytes(storageUsage.quotaBytes) }} ·
            {{ storageUsage.fileCount }} / {{ storageUsage.maxFiles }} 个文件
          </p>
        </el-card>
      </section>

      <el-card class="files-card" shadow="never">
        <template #header>
          <div class="card-header">
            <div><strong>我的文件</strong><span class="path-label">/{{ currentPath }}</span></div>
            <div><el-button :disabled="!currentPath" @click="goUp">返回上级</el-button><el-button type="primary" plain @click="refreshFiles">刷新</el-button></div>
          </div>
        </template>
        <section class="upload-panel">
          <div class="upload-picker">
            <label class="file-picker-label">
              <span>{{ selectedFile ? '重新选择文件' : '选择本地文件' }}</span>
              <input type="file" :disabled="['hashing', 'initializing', 'uploading', 'verifying', 'cancelling'].includes(uploadStatus)" @change="selectFile" />
            </label>
            <div class="selected-file-copy">
              <strong>{{ selectedFile?.name ?? '尚未选择文件' }}</strong>
              <span>{{ selectedFile ? formatBytes(selectedFile.size) : '文件将上传到当前私人目录' }}</span>
            </div>
            <el-button
              type="primary"
              :disabled="!selectedFile || connectionStatus !== 'connected' || authStatus !== 'authenticated' || isDownloadActive() || ['hashing', 'initializing', 'uploading', 'verifying', 'cancelling'].includes(uploadStatus)"
              @click="startUpload"
            >上传</el-button>
            <el-button
              v-if="['hashing', 'initializing', 'uploading', 'verifying'].includes(uploadStatus)"
              type="danger"
              plain
              @click="cancelUpload"
            >取消</el-button>
          </div>
          <div v-if="uploadStatus !== 'idle'" class="upload-progress-row">
            <el-progress :percentage="uploadProgress" :status="uploadStatus === 'error' ? 'exception' : uploadStatus === 'completed' ? 'success' : undefined" />
            <div class="upload-meta">
              <span>{{ uploadMessage }}</span>
              <span v-if="uploadSpeed > 0">{{ formatBytes(uploadSpeed) }}/s</span>
              <el-tag size="small">{{ uploadStatus }}</el-tag>
            </div>
          </div>
        </section>
        <section v-if="downloadStatus !== 'idle'" class="download-panel">
          <div class="card-header">
            <div class="selected-file-copy">
              <strong>{{ downloadFileName || '下载任务' }}</strong>
              <span>{{ downloadMessage }}</span>
            </div>
            <el-button v-if="isDownloadCancelable()" type="danger" plain @click="cancelDownload">取消下载</el-button>
          </div>
          <el-progress
            :percentage="downloadProgress"
            :status="downloadStatus === 'error' ? 'exception' : downloadStatus === 'completed' ? 'success' : undefined"
          />
          <div class="download-meta">
            <span v-if="downloadSpeed > 0">{{ formatBytes(downloadSpeed) }}/s</span>
            <el-tag size="small">{{ downloadStatus }}</el-tag>
          </div>
        </section>
        <el-table :data="fileEntries" empty-text="私人目录为空；可在上方选择文件上传" @row-dblclick="openDirectory">
          <el-table-column label="名称" min-width="240">
            <template #default="scope"><span :class="{ 'directory-link': scope.row.type === 'directory' }">{{ scope.row.type === 'directory' ? '📁' : '📄' }} {{ scope.row.name }}</span></template>
          </el-table-column>
          <el-table-column prop="type" label="类型" width="110" />
          <el-table-column label="大小" width="140"><template #default="scope">{{ scope.row.type === 'file' ? formatBytes(scope.row.size) : '—' }}</template></el-table-column>
          <el-table-column label="修改时间" width="200"><template #default="scope">{{ new Date(scope.row.modifiedAt).toLocaleString() }}</template></el-table-column>
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="scope">
              <el-button
                v-if="scope.row.type === 'file'"
                type="primary"
                text
                :disabled="isDownloadActive() || ['hashing', 'initializing', 'uploading', 'verifying', 'cancelling'].includes(uploadStatus)"
                @click="startDownload(scope.row)"
              >下载</el-button>
            </template>
          </el-table-column>
        </el-table>
      </el-card>
    </template>

    <el-card class="connection-card" shadow="never">
      <template #header><div class="card-header"><strong>连接与协议</strong><span>SFTP-WS / v1</span></div></template>
      <div class="connection-facts">
        <span>连接 ID：{{ connectionId }}</span><span>最近心跳：{{ lastHeartbeat }}</span><span>{{ wsUrl }}</span>
      </div>
      <details><summary>最近协议事件</summary><ul class="event-list"><li v-for="entry in eventLog" :key="entry">{{ entry }}</li></ul></details>
    </el-card>

    <el-alert title="当前仍是本机 ws:// 开发链路；正式 TLS/WSS 将在 Phase 3 完成。Edge/Chrome 使用流式落盘，其他浏览器兼容模式限制为 32 MiB。" type="warning" :closable="false" show-icon />
  </main>
</template>

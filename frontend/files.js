const token = sessionStorage.getItem("token");
if (!token) {
  window.location.href = "/";
}

const currentCaseId = String(sessionStorage.getItem("currentCaseId") || "").trim();
if (!/^\d{6}$/.test(currentCaseId)) {
  window.location.href = "/dashboard.html";
}

const API_BASE = window.location.hostname === "localhost"
  ? "http://localhost:4000"
  : "https://lively-reverence-production-def3.up.railway.app";

const filesTableBody = document.getElementById("filesTableBody");
const listTitle = document.getElementById("listTitle");
const fileTypeFilter = document.getElementById("fileTypeFilter");
const dateFromFilter = document.getElementById("dateFromFilter");
const listMessage = document.getElementById("listMessage");
const previewModal = document.getElementById("previewModal");
const previewModalTitle = document.getElementById("previewModalTitle");
const previewModalViewport = document.getElementById("previewModalViewport");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomResetBtn = document.getElementById("zoomResetBtn");
const zoomLevel = document.getElementById("zoomLevel");
const closePreviewBtn = document.getElementById("closePreviewBtn");
const goToUploadBtn = document.getElementById("goToUploadBtn");
const backToCasesBtn = document.getElementById("backToCasesBtn");
const logoutBtn = document.getElementById("logoutBtn");
const copyrightYearEl = document.getElementById("copyrightYear");

let allFiles = [];
const previewUrlCache = new Map();
const previewPromiseCache = new Map();
let modalZoom = 1;

listTitle.textContent = `Dateiliste für Fall ${currentCaseId}`;

function setMessage(el, text, type) {
  el.textContent = text;
  el.classList.remove("error", "success");
  if (type) {
    el.classList.add(type);
  }
}

function formatDate(value) {
  return new Date(value).toLocaleString("de-CH", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatSizeKB(bytes) {
  return Math.max(1, Math.round(Number(bytes || 0) / 1024));
}

function decodeUtf8Safe(text) {
  const input = String(text || "");
  if (!/[ÃÂ][\x80-\xBF]/.test(input) && !input.includes("�")) {
    return input;
  }

  try {
    const decoded = decodeURIComponent(escape(input));
    return decoded || input;
  } catch {
    return input;
  }
}

function resolveFileType(file) {
  const mime = String(file.mime_type || "").toLowerCase();
  const name = String(file.original_name || "").toLowerCase();

  if (mime.includes("pdf") || name.endsWith(".pdf")) {
    return { className: "pdf", label: "PDF" };
  }

  if (mime.includes("png") || name.endsWith(".png")) {
    return { className: "png", label: "PNG" };
  }

  if (mime.includes("jpeg") || mime.includes("jpg") || name.endsWith(".jpg") || name.endsWith(".jpeg")) {
    return { className: "jpg", label: "JPG" };
  }

  return { className: "generic", label: "FILE" };
}

function compactDocId(id) {
  const raw = String(id || "").replace(/-/g, "").slice(0, 12);
  const numeric = Number.parseInt(raw || "0", 16) % 100000000;
  return String(Number.isFinite(numeric) ? numeric : 0).padStart(8, "0");
}

function filterFiles(files) {
  const type = String(fileTypeFilter.value || "all").toLowerCase();
  const fromDate = dateFromFilter.value ? new Date(`${dateFromFilter.value}T00:00:00`) : null;

  return files.filter((file) => {
    const fileType = resolveFileType(file).className;
    const uploadedAt = new Date(file.uploaded_at);

    if (type !== "all" && fileType !== type) {
      return false;
    }

    if (fromDate && uploadedAt < fromDate) {
      return false;
    }

    return true;
  });
}

function revokeAllPreviewUrls() {
  for (const url of previewUrlCache.values()) {
    URL.revokeObjectURL(url);
  }
  previewUrlCache.clear();
  previewPromiseCache.clear();
}

async function getPreviewUrl(file) {
  const fileType = resolveFileType(file);
  if (!["pdf", "png", "jpg"].includes(fileType.className)) {
    return null;
  }

  if (previewUrlCache.has(file.id)) {
    return previewUrlCache.get(file.id);
  }

  if (previewPromiseCache.has(file.id)) {
    return previewPromiseCache.get(file.id);
  }

  const promise = fetch(`${API_BASE}/cases/${currentCaseId}/files/${file.id}/download`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  previewPromiseCache.set(file.id, promise);

  const response = await promise;
  previewPromiseCache.delete(file.id);

  if (!response.ok) {
    let detail = "Vorschau konnte nicht geladen werden.";
    try {
      const payload = await response.json();
      if (payload && payload.error) {
        detail = payload.error;
      }
    } catch {
      // Ignore non-JSON error bodies.
    }

    if (response.status === 404) {
      detail = "Datei fehlt im Serverspeicher. Bitte dieses Dokument neu hochladen.";
    }

    setMessage(listMessage, `${decodeUtf8Safe(file.original_name)}: ${detail}`, "error");
    return null;
  }

  const blob = await response.blob();
  const typedBlob = blob.type ? blob : new Blob([blob], { type: file.mime_type || "application/octet-stream" });
  const objectUrl = URL.createObjectURL(typedBlob);
  previewUrlCache.set(file.id, objectUrl);
  return objectUrl;
}

function clampZoom(nextZoom) {
  return Math.max(0.5, Math.min(4, nextZoom));
}

function updateModalZoom(value) {
  modalZoom = clampZoom(value);
  const content = previewModalViewport.querySelector(".preview-modal-content");
  if (content instanceof HTMLElement) {
    content.style.transform = `scale(${modalZoom})`;
  }
  zoomLevel.textContent = `${Math.round(modalZoom * 100)}%`;
}

function closePreviewModal() {
  previewModal.classList.add("hidden");
  previewModal.setAttribute("aria-hidden", "true");
  previewModalViewport.innerHTML = "";
  document.body.style.overflow = "";
}

async function openPreviewModal(file) {
  const fileType = resolveFileType(file);
  const previewUrl = await getPreviewUrl(file);
  if (!previewUrl) {
    setMessage(listMessage, "Vorschau konnte nicht geladen werden.", "error");
    return;
  }

  previewModalTitle.textContent = `${decodeUtf8Safe(file.original_name)} · ${formatDate(file.uploaded_at)}`;
  previewModal.classList.remove("hidden");
  previewModal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";

  if (fileType.className === "pdf") {
    previewModalViewport.innerHTML = `<iframe class="preview-modal-frame preview-modal-content" src="${previewUrl}" title="PDF Vorschau ${decodeUtf8Safe(file.original_name)}"></iframe>`;
  } else {
    previewModalViewport.innerHTML = `<img class="preview-modal-image preview-modal-content" src="${previewUrl}" alt="Vorschau ${decodeUtf8Safe(file.original_name)}" />`;
  }

  updateModalZoom(1);
}

async function loadRowPreview(file) {
  const cell = filesTableBody.querySelector(`.preview-cell[data-file-id="${file.id}"]`);
  if (!(cell instanceof HTMLElement)) {
    return;
  }

  const fileType = resolveFileType(file);
  if (!["pdf", "png", "jpg"].includes(fileType.className)) {
    cell.innerHTML = '<span class="row-preview-empty">Keine Vorschau</span>';
    return;
  }

  cell.innerHTML = '<div class="row-preview-loading">Lädt...</div>';
  const previewUrl = await getPreviewUrl(file);
  if (!previewUrl) {
    cell.innerHTML = '<span class="row-preview-empty">Neu hochladen</span>';
    return;
  }

  if (fileType.className === "pdf") {
    cell.innerHTML = `<iframe class="row-preview-frame" src="${previewUrl}" title="PDF Vorschau ${decodeUtf8Safe(file.original_name)}"></iframe>`;
    return;
  }

  cell.innerHTML = `<img class="row-preview-image" src="${previewUrl}" alt="Vorschau ${decodeUtf8Safe(file.original_name)}" />`;
}

function renderFiles(files) {
  filesTableBody.innerHTML = "";

  if (!files || files.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td colspan=\"7\">Keine Dateien für die gewählten Filter gefunden.</td>";
    filesTableBody.appendChild(tr);
    return;
  }

  for (const file of files) {
    const fileType = resolveFileType(file);
    const displayName = decodeUtf8Safe(file.original_name);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="doc-id" title="${file.id}">${compactDocId(file.id)}</td>
      <td>${formatDate(file.uploaded_at)}</td>
      <td>${displayName}</td>
      <td class="preview-cell" data-file-id="${file.id}" title="Klicken für grosse Vorschau"><div class="row-preview-loading">Lädt...</div></td>
      <td><span class="file-icon ${fileType.className}">${fileType.label}</span></td>
      <td>${formatSizeKB(file.size_bytes)}</td>
      <td class="actions-cell">
        <button type="button" class="btn-inline download" data-action="download" data-id="${file.id}">Download</button>
        <button type="button" class="btn-inline delete" data-action="delete" data-id="${file.id}">Löschen</button>
      </td>
    `;
    filesTableBody.appendChild(tr);
  }

  for (const file of files) {
    void loadRowPreview(file);
  }
}

async function loadFiles() {
  const res = await fetch(`${API_BASE}/cases/${currentCaseId}/files`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    allFiles = data.files || [];
    renderFiles(filterFiles(allFiles));
    return;
  }

  setMessage(listMessage, data.error || "Dateiliste konnte nicht geladen werden.", "error");
}

async function downloadFile(fileId) {
  const response = await fetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}/download`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    setMessage(listMessage, "Datei konnte nicht heruntergeladen werden.", "error");
    return;
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;

  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8'')?\"?([^\";]+)\"?/i);
  link.download = match ? decodeURIComponent(match[1]) : `download-${fileId}`;

  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function deleteFile(fileId, triggerButton) {
  if (triggerButton instanceof HTMLButtonElement) {
    triggerButton.disabled = true;
    triggerButton.textContent = "Lösche...";
  }

  const response = await fetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (triggerButton instanceof HTMLButtonElement) {
      triggerButton.disabled = false;
      triggerButton.textContent = "Löschen";
    }
    setMessage(listMessage, payload.error || "Datei konnte nicht gelöscht werden.", "error");
    return;
  }

  const cachedUrl = previewUrlCache.get(fileId);
  if (cachedUrl) {
    URL.revokeObjectURL(cachedUrl);
    previewUrlCache.delete(fileId);
  }
  previewPromiseCache.delete(fileId);

  allFiles = allFiles.filter((file) => file.id !== fileId);
  renderFiles(filterFiles(allFiles));
  setMessage(listMessage, "Datei erfolgreich gelöscht.", "success");
}

filesTableBody.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.action;
  const fileId = target.dataset.id;

  const previewCell = target.closest(".preview-cell");
  if (previewCell instanceof HTMLElement) {
    const previewId = previewCell.dataset.fileId;
    const file = allFiles.find((item) => item.id === previewId);
    if (file) {
      await openPreviewModal(file);
    }
    return;
  }

  if (!action || !fileId) {
    return;
  }

  if (action === "download") {
    await downloadFile(fileId);
    return;
  }

  if (action === "delete") {
    void deleteFile(fileId, target);
  }
});

for (const element of [fileTypeFilter, dateFromFilter]) {
  element.addEventListener("change", () => {
    renderFiles(filterFiles(allFiles));
  });
}

goToUploadBtn.addEventListener("click", () => {
  window.location.href = "/upload.html";
});

backToCasesBtn.addEventListener("click", () => {
  window.location.href = "/dashboard.html";
});

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem("token");
  sessionStorage.removeItem("currentCaseId");
  window.location.href = "/";
});

zoomOutBtn.addEventListener("click", () => {
  updateModalZoom(modalZoom - 0.25);
});

zoomInBtn.addEventListener("click", () => {
  updateModalZoom(modalZoom + 0.25);
});

zoomResetBtn.addEventListener("click", () => {
  updateModalZoom(1);
});

closePreviewBtn.addEventListener("click", () => {
  closePreviewModal();
});

previewModal.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  if (target.dataset.closePreview === "true") {
    closePreviewModal();
  }
});

window.addEventListener("beforeunload", () => {
  closePreviewModal();
  revokeAllPreviewUrls();
});

copyrightYearEl.textContent = String(new Date().getFullYear());
loadFiles();

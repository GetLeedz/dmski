const token = sessionStorage.getItem("token");
if (!token) {
  window.location.href = "/";
}

const API_BASE = window.location.hostname === "localhost"
  ? "http://localhost:4000"
  : "https://lively-reverence-production-def3.up.railway.app";

const caseForm = document.getElementById("caseForm");
const caseMessage = document.getElementById("caseMessage");
const caseIdInput = document.getElementById("caseId");
const caseDateInput = document.getElementById("caseDate");
const uploadMessage = document.getElementById("uploadMessage");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const uploadBtn = document.getElementById("uploadBtn");
const filesTableBody = document.getElementById("filesTableBody");
const workspaceHint = document.getElementById("workspaceHint");
const workspaceControls = document.getElementById("workspaceControls");
const panelUpload = document.getElementById("panelUpload");
const panelList = document.getElementById("panelList");
const tabUpload = document.getElementById("tabUpload");
const tabList = document.getElementById("tabList");
const createCaseBtn = document.getElementById("createCaseBtn");
const logoutBtn = document.getElementById("logoutBtn");
const existingCasesSelect = document.getElementById("existingCasesSelect");
const goToUploadBtn = document.getElementById("goToUploadBtn");
const fileTypeFilter = document.getElementById("fileTypeFilter");
const dateFromFilter = document.getElementById("dateFromFilter");
const copyrightYearEl = document.getElementById("copyrightYear");
const uploadQueue = document.getElementById("uploadQueue");

let currentCaseId = "";
let pendingFiles = [];
let allFiles = [];
let allCases = [];
const ALLOWED_EXTENSIONS = new Set(["pdf", "jpg", "jpeg", "png"]);
const ALLOWED_FILES_LABEL = "PDF, JPG, JPEG, PNG";

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

function todayIsoDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function generateCaseId() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function resetAutoFields() {
  caseIdInput.value = generateCaseId();
  caseDateInput.value = todayIsoDate();
}

function setWorkspaceEnabled(enabled) {
  workspaceControls.classList.toggle("disabled", !enabled);
  dropzone.style.pointerEvents = enabled ? "auto" : "none";
  dropzone.style.opacity = enabled ? "1" : "0.5";
  uploadBtn.disabled = !enabled || pendingFiles.length === 0;
  workspaceHint.textContent = enabled
    ? `Aktiver Fall: ${currentCaseId}. Du kannst zwischen Upload und Dateiliste wechseln.`
    : "Zuerst Dossier eröffnen, danach Upload oder Dateiliste nutzen.";
}

function switchTab(target) {
  const uploadActive = target === "upload";
  tabUpload.classList.toggle("active", uploadActive);
  tabList.classList.toggle("active", !uploadActive);
  panelUpload.classList.toggle("hidden", !uploadActive);
  panelList.classList.toggle("hidden", uploadActive);
}

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

function splitAcceptedFiles(files) {
  const accepted = [];
  const rejected = [];

  for (const file of Array.from(files || [])) {
    const ext = String(file.name || "").toLowerCase().split(".").pop() || "";
    if (ALLOWED_EXTENSIONS.has(ext)) {
      accepted.push(file);
      continue;
    }
    rejected.push(file);
  }

  return { accepted, rejected };
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

function renderPendingFiles() {
  uploadQueue.innerHTML = "";

  if (pendingFiles.length === 0) {
    return;
  }

  for (const file of pendingFiles) {
    const safeName = decodeUtf8Safe(file.name);
    const row = document.createElement("div");
    row.className = "queue-item";
    row.dataset.fileName = file.name;
    row.innerHTML = `
      <div class="queue-head">
        <span class="queue-name">${safeName}</span>
        <span class="queue-meta"><span class="spinner"></span><span class="queue-state">Bereit</span> <span class="queue-percent">0%</span></span>
      </div>
      <div class="progress"><div class="progress-bar"></div></div>
    `;
    uploadQueue.appendChild(row);
  }
}

function updateQueueProgress(fileName, percent, state, className) {
  const row = Array.from(uploadQueue.querySelectorAll(".queue-item"))
    .find((item) => item.dataset.fileName === fileName);

  if (!row) return;

  row.classList.remove("uploading", "done", "error");
  if (className) {
    row.classList.add(className);
  }

  const bar = row.querySelector(".progress-bar");
  const pct = row.querySelector(".queue-percent");
  const status = row.querySelector(".queue-state");

  if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (pct) pct.textContent = `${Math.round(percent)}%`;
  if (status) status.textContent = state;
}

function uploadSingleFile(file) {
  return new Promise((resolve, reject) => {
    const body = new FormData();
    body.append("files", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/cases/${currentCaseId}/files`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = (event.loaded / event.total) * 100;
      updateQueueProgress(file.name, percent, "Lädt...", "uploading");
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        updateQueueProgress(file.name, 100, "Fertig", "done");
        resolve();
        return;
      }

      let errorText = "Upload fehlgeschlagen.";
      try {
        const parsed = JSON.parse(xhr.responseText || "{}");
        if (parsed.error) {
          errorText = parsed.error;
        }
      } catch {
        // Ignore JSON parse errors.
      }
      updateQueueProgress(file.name, 0, "Fehler", "error");
      reject(new Error(errorText));
    };

    xhr.onerror = () => {
      updateQueueProgress(file.name, 0, "Fehler", "error");
      reject(new Error("Server nicht erreichbar."));
    };

    xhr.send(body);
  });
}

async function downloadFile(fileId) {
  const response = await fetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}/download`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    let errorText = "Datei konnte nicht heruntergeladen werden.";
    try {
      const json = await response.json();
      if (json.error) {
        errorText = json.error;
      }
    } catch {
      // Ignore parse errors on non-JSON responses.
    }
    setMessage(uploadMessage, errorText, "error");
    return;
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;

  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
  link.download = match ? decodeURIComponent(match[1]) : `download-${fileId}`;

  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function deleteFile(fileId) {
  const confirmDelete = window.confirm("Datei wirklich löschen?");
  if (!confirmDelete) {
    return;
  }

  const response = await fetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    setMessage(uploadMessage, payload.error || "Datei konnte nicht gelöscht werden.", "error");
    return;
  }

  setMessage(uploadMessage, "Datei erfolgreich gelöscht.", "success");
  await loadFiles();
}

function renderFiles(files) {
  filesTableBody.innerHTML = "";

  if (!files || files.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td colspan=\"6\">Keine Dateien für die gewählten Filter gefunden.</td>";
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
      <td><span class="file-icon ${fileType.className}">${fileType.label}</span></td>
      <td>${formatSizeKB(file.size_bytes)}</td>
      <td class="actions-cell">
        <button type="button" class="btn-inline download" data-action="download" data-id="${file.id}">Download</button>
        <button type="button" class="btn-inline delete" data-action="delete" data-id="${file.id}">Löschen</button>
      </td>
    `;
    filesTableBody.appendChild(tr);
  }
}

async function loadFiles() {
  if (!currentCaseId) return;

  const res = await fetch(`${API_BASE}/cases/${currentCaseId}/files`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (res.ok) {
    allFiles = data.files || [];
    renderFiles(filterFiles(allFiles));
    return;
  }

  setMessage(uploadMessage, data.error || "Dateiliste konnte nicht geladen werden.", "error");
}

async function loadCasesList() {
  const res = await fetch(`${API_BASE}/cases`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    existingCasesSelect.innerHTML = "<option value=\"\">Fallliste konnte nicht geladen werden</option>";
    return;
  }

  allCases = data.cases || [];
  existingCasesSelect.innerHTML = "";

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = allCases.length > 0
    ? "Bitte Dossier auswählen"
    : "Noch keine Dossiers vorhanden";
  existingCasesSelect.appendChild(placeholder);

  for (const item of allCases) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.id} - ${item.case_name} (${String(item.case_date || "")})`;
    existingCasesSelect.appendChild(option);
  }
}

async function openCase(caseId) {
  const normalized = String(caseId || "").trim();
  if (!/^\d{6}$/.test(normalized)) {
    setMessage(caseMessage, "Bitte eine gültige 6-stellige Fall-ID eingeben.", "error");
    return;
  }

  currentCaseId = normalized;
  caseIdInput.value = normalized;

  const selected = allCases.find((item) => item.id === normalized);
  if (selected) {
    caseDateInput.value = String(selected.case_date || "").slice(0, 10) || todayIsoDate();
    document.getElementById("caseName").value = selected.case_name || "";
  }

  setWorkspaceEnabled(true);
  setMessage(caseMessage, `Dossier ${normalized} geöffnet.`, "success");
  setMessage(uploadMessage, "", null);
  pendingFiles = [];
  renderPendingFiles();
  await loadFiles();
  switchTab("list");
}

caseForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const caseId = String(caseIdInput.value || "").trim();
  const caseDate = caseDateInput.value;
  const caseName = String(document.getElementById("caseName").value || "").trim();

  if (!/^\d{6}$/.test(caseId)) {
    setMessage(caseMessage, "ID muss exakt 6-stellig sein.", "error");
    return;
  }

  createCaseBtn.disabled = true;

  let created = null;
  let tries = 0;
  let nextCaseId = caseId;

  while (!created && tries < 6) {
    tries += 1;
    const res = await fetch(`${API_BASE}/cases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ caseId: nextCaseId, caseDate, caseName })
    });

    const data = await res.json();
    if (res.ok) {
      created = data;
      break;
    }

    if (res.status === 409) {
      nextCaseId = generateCaseId();
      continue;
    }

    setMessage(caseMessage, data.error || "Fall konnte nicht erstellt werden.", "error");
    createCaseBtn.disabled = false;
    return;
  }

  if (!created) {
    setMessage(caseMessage, "Konnte keine freie Fall-ID erzeugen. Bitte erneut versuchen.", "error");
    createCaseBtn.disabled = false;
    resetAutoFields();
    return;
  }

  currentCaseId = created.id;
  caseIdInput.value = created.id;
  setMessage(caseMessage, `Fall ${created.id} erstellt. Dateien können hochgeladen werden.`, "success");
  setMessage(uploadMessage, "", null);
  pendingFiles = [];
  allFiles = [];
  setWorkspaceEnabled(true);
  switchTab("upload");
  createCaseBtn.disabled = false;
  await loadCasesList();
  loadFiles();
});

function addPendingFiles(newFiles) {
  const { accepted, rejected } = splitAcceptedFiles(newFiles);
  const existingNames = new Set(pendingFiles.map((f) => f.name));
  for (const f of accepted) {
    if (!existingNames.has(f.name)) {
      pendingFiles.push(f);
      existingNames.add(f.name);
    }
  }

  if (rejected.length > 0) {
    const rejectedNames = rejected.map((f) => decodeUtf8Safe(f.name)).join(", ");
    const message = `Nur ${ALLOWED_FILES_LABEL} erlaubt. Nicht akzeptiert: ${rejectedNames}`;
    window.alert(message);
    setMessage(uploadMessage, message, "error");
  }

  uploadBtn.disabled = pendingFiles.length === 0 || !currentCaseId;
  renderPendingFiles();
  if (pendingFiles.length > 0) {
    setMessage(uploadMessage, `${pendingFiles.length} Datei(en) bereit zum Upload.`, "success");
  } else {
    setMessage(uploadMessage, "", null);
  }
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => addPendingFiles(fileInput.files));

for (const eventName of ["dragenter", "dragover"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("drag");
  });
}

for (const eventName of ["dragleave", "drop"]) {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("drag");
  });
}

dropzone.addEventListener("drop", (event) => {
  addPendingFiles(event.dataTransfer.files);
  startUpload();
});

async function startUpload() {
  if (!currentCaseId) {
    setMessage(uploadMessage, "Zuerst einen Fall erstellen.", "error");
    return;
  }

  if (pendingFiles.length === 0) {
    setMessage(uploadMessage, "Keine Dateien ausgewählt.", "error");
    return;
  }

  uploadBtn.disabled = true;

  let successCount = 0;
  for (const file of pendingFiles) {
    try {
      await uploadSingleFile(file);
      successCount += 1;
    } catch (error) {
      setMessage(uploadMessage, error.message || "Upload fehlgeschlagen.", "error");
      uploadBtn.disabled = false;
      return;
    }
  }

  setMessage(uploadMessage, `${successCount} Datei(en) erfolgreich hochgeladen.`, "success");
  pendingFiles = [];
  fileInput.value = "";
  renderPendingFiles();
  await loadFiles();
  switchTab("upload");
}

uploadBtn.addEventListener("click", () => startUpload());

goToUploadBtn.addEventListener("click", () => switchTab("upload"));
tabUpload.addEventListener("click", () => switchTab("upload"));
tabList.addEventListener("click", async () => {
  switchTab("list");
  await loadFiles();
});

filesTableBody.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.action;
  const fileId = target.dataset.id;
  if (!action || !fileId) {
    return;
  }

  if (action === "download") {
    await downloadFile(fileId);
    return;
  }

  if (action === "delete") {
    await deleteFile(fileId);
  }
});

for (const element of [fileTypeFilter, dateFromFilter]) {
  element.addEventListener("change", () => {
    renderFiles(filterFiles(allFiles));
  });
}

existingCasesSelect.addEventListener("change", async () => {
  if (!existingCasesSelect.value) return;
  await openCase(existingCasesSelect.value);
});

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem("token");
  window.location.href = "/";
});

copyrightYearEl.textContent = String(new Date().getFullYear());
resetAutoFields();
setWorkspaceEnabled(false);
switchTab("upload");
loadCasesList();

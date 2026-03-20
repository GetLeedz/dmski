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
const fileTypeFilter = document.getElementById("fileTypeFilter");
const dateFromFilter = document.getElementById("dateFromFilter");
const dateToFilter = document.getElementById("dateToFilter");
const copyrightYearEl = document.getElementById("copyrightYear");

let currentCaseId = "";
let pendingFiles = [];
let allFiles = [];

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
  const value = String(id || "");
  if (value.length <= 12) {
    return value;
  }
  return `${value.slice(0, 8)}...`;
}

function filterFiles(files) {
  const type = String(fileTypeFilter.value || "all").toLowerCase();
  const fromDate = dateFromFilter.value ? new Date(`${dateFromFilter.value}T00:00:00`) : null;
  const toDate = dateToFilter.value ? new Date(`${dateToFilter.value}T23:59:59`) : null;

  return files.filter((file) => {
    const fileType = resolveFileType(file).className;
    const uploadedAt = new Date(file.uploaded_at);

    if (type !== "all" && fileType !== type) {
      return false;
    }

    if (fromDate && uploadedAt < fromDate) {
      return false;
    }

    if (toDate && uploadedAt > toDate) {
      return false;
    }

    return true;
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
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="doc-id" title="${file.id}">${compactDocId(file.id)}</td>
      <td>${formatDate(file.uploaded_at)}</td>
      <td>${file.original_name}</td>
      <td><span class="file-icon ${fileType.className}">${fileType.label}</span></td>
      <td>${Math.round(file.size_bytes / 1024)}</td>
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
  loadFiles();
});

function setPending(files) {
  pendingFiles = Array.from(files || []);
  uploadBtn.disabled = pendingFiles.length === 0 || !currentCaseId;
  if (pendingFiles.length > 0) {
    setMessage(uploadMessage, `${pendingFiles.length} Datei(en) bereit zum Upload.`, "success");
  }
}

dropzone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => setPending(fileInput.files));

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
  setPending(event.dataTransfer.files);
});

uploadBtn.addEventListener("click", async () => {
  if (!currentCaseId) {
    setMessage(uploadMessage, "Zuerst einen Fall erstellen.", "error");
    return;
  }

  if (pendingFiles.length === 0) {
    setMessage(uploadMessage, "Keine Dateien ausgewählt.", "error");
    return;
  }

  const body = new FormData();
  for (const file of pendingFiles) {
    body.append("files", file);
  }

  uploadBtn.disabled = true;

  const res = await fetch(`${API_BASE}/cases/${currentCaseId}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body
  });

  const data = await res.json();
  if (!res.ok) {
    setMessage(uploadMessage, data.error || "Upload fehlgeschlagen.", "error");
    uploadBtn.disabled = false;
    return;
  }

  setMessage(uploadMessage, `${data.uploaded.length} Datei(en) erfolgreich hochgeladen.`, "success");
  pendingFiles = [];
  fileInput.value = "";
  await loadFiles();
  switchTab("list");
});

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

for (const element of [fileTypeFilter, dateFromFilter, dateToFilter]) {
  element.addEventListener("change", () => {
    renderFiles(filterFiles(allFiles));
  });
}

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem("token");
  window.location.href = "/";
});

copyrightYearEl.textContent = String(new Date().getFullYear());
resetAutoFields();
setWorkspaceEnabled(false);
switchTab("upload");

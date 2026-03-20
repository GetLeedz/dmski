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

let currentCaseId = "";
let pendingFiles = [];

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
    : "Zuerst Dossier eroeffnen, danach Upload oder Dateiliste nutzen.";
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

function renderFiles(files) {
  filesTableBody.innerHTML = "";

  if (!files || files.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="5">Noch keine Dateien fuer diesen Fall vorhanden.</td>`;
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
    renderFiles(data.files || []);
  }
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
  setMessage(caseMessage, `Fall ${created.id} erstellt. Dateien koennen hochgeladen werden.`, "success");
  setMessage(uploadMessage, "", null);
  pendingFiles = [];
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
    setMessage(uploadMessage, "Keine Dateien ausgewaehlt.", "error");
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

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem("token");
  window.location.href = "/";
});

resetAutoFields();
setWorkspaceEnabled(false);
switchTab("upload");

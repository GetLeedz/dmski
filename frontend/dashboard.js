const token = sessionStorage.getItem("token");
if (!token) {
  window.location.href = "/";
}

const API_BASE = window.location.hostname === "localhost"
  ? "http://localhost:4000"
  : "https://lively-reverence-production-def3.up.railway.app";

const caseForm = document.getElementById("caseForm");
const caseMessage = document.getElementById("caseMessage");
const uploadMessage = document.getElementById("uploadMessage");
const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const uploadBtn = document.getElementById("uploadBtn");
const filesTableBody = document.getElementById("filesTableBody");
const logoutBtn = document.getElementById("logoutBtn");

let currentCaseId = "";
let pendingFiles = [];

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
    minute: "2-digit"
  });
}

function renderFiles(files) {
  filesTableBody.innerHTML = "";
  for (const file of files) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${formatDate(file.uploaded_at)}</td>
      <td>${file.original_name}</td>
      <td>${file.mime_type}</td>
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

  const caseId = String(document.getElementById("caseId").value || "").trim();
  const caseDate = document.getElementById("caseDate").value;
  const caseName = String(document.getElementById("caseName").value || "").trim();

  if (!/^\d{6}$/.test(caseId)) {
    setMessage(caseMessage, "ID muss exakt 6-stellig sein.", "error");
    return;
  }

  const res = await fetch(`${API_BASE}/cases`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ caseId, caseDate, caseName })
  });

  const data = await res.json();
  if (!res.ok) {
    setMessage(caseMessage, data.error || "Fall konnte nicht erstellt werden.", "error");
    return;
  }

  currentCaseId = data.id;
  setMessage(caseMessage, `Fall ${data.id} erstellt. Dateien koennen hochgeladen werden.`, "success");
  setMessage(uploadMessage, "", null);
  pendingFiles = [];
  uploadBtn.disabled = true;
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
});

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem("token");
  window.location.href = "/";
});

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

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const uploadBtn = document.getElementById("uploadBtn");
const uploadMessage = document.getElementById("uploadMessage");
const uploadQueue = document.getElementById("uploadQueue");
const workspaceHint = document.getElementById("workspaceHint");
const goToListBtn = document.getElementById("goToListBtn");
const backToCasesBtn = document.getElementById("backToCasesBtn");
const logoutBtn = document.getElementById("logoutBtn");
const copyrightYearEl = document.getElementById("copyrightYear");

let pendingFiles = [];
const ALLOWED_EXTENSIONS = new Set(["pdf", "jpg", "jpeg", "png"]);
const ALLOWED_FILES_LABEL = "PDF, JPG, JPEG, PNG";

workspaceHint.textContent = `Aktiver Fall: ${currentCaseId}. Dateien werden direkt hochgeladen, wenn sie in die Fläche gezogen werden.`;

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

function setMessage(el, text, type) {
  el.textContent = text;
  el.classList.remove("error", "success");
  if (type) {
    el.classList.add(type);
  }
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

  uploadBtn.disabled = pendingFiles.length === 0;
  renderPendingFiles();

  if (pendingFiles.length > 0) {
    setMessage(uploadMessage, `${pendingFiles.length} Datei(en) bereit zum Upload.`, "success");
  }
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

async function startUpload() {
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

uploadBtn.addEventListener("click", () => startUpload());

goToListBtn.addEventListener("click", () => {
  window.location.href = "/files.html";
});

backToCasesBtn.addEventListener("click", () => {
  window.location.href = "/dashboard.html";
});

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem("token");
  sessionStorage.removeItem("currentCaseId");
  window.location.href = "/";
});

copyrightYearEl.textContent = String(new Date().getFullYear());

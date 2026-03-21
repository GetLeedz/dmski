const token = sessionStorage.getItem("token");
if (!token) {
  window.location.replace("/");
}

const currentCaseId = String(sessionStorage.getItem("currentCaseId") || "").trim();
if (!/^\d{6}$/.test(currentCaseId)) {
  window.location.replace("/dashboard.html");
}

document.body.style.visibility = "visible";

const host = String(window.location.hostname || "").toLowerCase();
const isLocalHost = host === "localhost"
  || host === "127.0.0.1"
  || host === "0.0.0.0"
  || host === "::1"
  || host.endsWith(".local")
  || /^192\.168\./.test(host)
  || /^10\./.test(host)
  || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);

const API_BASE = isLocalHost
  ? "http://localhost:4000"
  : "https://lively-reverence-production-def3.up.railway.app";

const OUTAGE_STATUSES = new Set([502, 503, 504]);
let serviceAlertEl = null;

function showServiceAlert(detail) {
  if (!serviceAlertEl) {
    serviceAlertEl = document.createElement("div");
    serviceAlertEl.className = "service-alert";
    const page = document.querySelector(".page");
    if (page) {
      page.prepend(serviceAlertEl);
    } else {
      document.body.prepend(serviceAlertEl);
    }
  }

  const suffix = detail ? ` (${detail})` : "";
  serviceAlertEl.textContent = `Server-Störung erkannt. Einige Funktionen sind derzeit eingeschränkt. Bitte in 1-2 Minuten erneut versuchen.${suffix}`;
}

const dropzone = document.getElementById("dropzone");
const fileInput = document.getElementById("fileInput");
const uploadMessage = document.getElementById("uploadMessage");
const uploadQueue = document.getElementById("uploadQueue");
const activeCaseBanner = document.getElementById("activeCaseBanner");
const workspaceHint = document.getElementById("workspaceHint");
const goToListBtn = document.getElementById("goToListBtn");
const logoutBtn = document.getElementById("logoutBtn");
const copyrightYearEl = document.getElementById("copyrightYear");

let pendingFiles = [];
let isUploading = false;
let totalUploadedCount = 0;
const ALLOWED_EXTENSIONS = new Set(["pdf", "jpg", "jpeg", "png"]);
const ALLOWED_FILES_LABEL = "PDF, JPG, JPEG, PNG";

activeCaseBanner.textContent = `WICHTIG: Du arbeitest im Fall ${currentCaseId}`;
workspaceHint.textContent = "Dateien werden direkt hochgeladen: Drag&Drop, Klick-Auswahl oder Einfügen mit Ctrl+V.";

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

function getFileKey(file) {
  return `${file.name}__${file.size}__${file.lastModified}`;
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
  if (pendingFiles.length === 0) {
    return;
  }

  for (const file of pendingFiles) {
    const fileKey = getFileKey(file);
    const existingRow = uploadQueue.querySelector(`.queue-item[data-file-key="${CSS.escape(fileKey)}"]`);
    if (existingRow) {
      continue;
    }

    const safeName = decodeUtf8Safe(file.name);
    const row = document.createElement("div");
    row.className = "queue-item";
    row.dataset.fileKey = fileKey;
    row.innerHTML = `
      <div class="queue-head">
        <span class="queue-name">${safeName}</span>
        <span class="queue-meta"><span class="spinner"></span><span class="queue-state">Bereit</span> <span class="queue-percent">0%</span><button type="button" class="queue-delete" title="Datei löschen" aria-label="Datei löschen" hidden><svg class="queue-delete-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h2v9H7V9Zm4 0h2v9h-2V9Zm4 0h2v9h-2V9Z"/></svg></button></span>
      </div>
      <div class="progress"><div class="progress-bar"></div></div>
    `;
    uploadQueue.appendChild(row);
  }
}

function updateQueueProgress(fileKey, percent, state, className) {
  const row = uploadQueue.querySelector(`.queue-item[data-file-key="${CSS.escape(fileKey)}"]`);

  if (!row) return;

  row.classList.remove("uploading", "done", "error");
  if (className) {
    row.classList.add(className);
  }

  const bar = row.querySelector(".progress-bar");
  const pct = row.querySelector(".queue-percent");
  const status = row.querySelector(".queue-state");
  const deleteBtn = row.querySelector(".queue-delete");

  if (bar) bar.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  if (pct) pct.textContent = `${Math.round(percent)}%`;
  if (status) status.textContent = state;
  if (deleteBtn) deleteBtn.hidden = !(row.classList.contains("done") && Boolean(row.dataset.fileId));

  // Show AI waveform while KI is running, remove when done
  let thinkingEl = row.querySelector(".queue-ai-thinking");
  if (state === "Analysiere...") {
    if (!thinkingEl) {
      thinkingEl = document.createElement("div");
      thinkingEl.className = "queue-ai-thinking";
      thinkingEl.innerHTML = `<div class="ai-wave"><span></span><span></span><span></span><span></span><span></span><span></span><span></span></div><span>KI analysiert Dokument…</span>`;
      row.appendChild(thinkingEl);
    }
  } else if (thinkingEl) {
    thinkingEl.remove();
  }
}
function setRowUploadedFileId(fileKey, fileId) {
  const row = uploadQueue.querySelector(`.queue-item[data-file-key="${CSS.escape(fileKey)}"]`);
  if (!row || !fileId) {
    return;
  }

  row.dataset.fileId = fileId;
  const deleteBtn = row.querySelector(".queue-delete");
  if (deleteBtn && row.classList.contains("done")) {
    deleteBtn.hidden = false;
  }
}

function addPendingFiles(newFiles) {
  const { accepted, rejected } = splitAcceptedFiles(newFiles);
  const existingKeys = new Set(pendingFiles.map((f) => getFileKey(f)));
  for (const f of accepted) {
    const key = getFileKey(f);
    if (!existingKeys.has(key)) {
      pendingFiles.push(f);
      existingKeys.add(key);
    }
  }

  if (rejected.length > 0) {
    const rejectedNames = rejected.map((f) => decodeUtf8Safe(f.name)).join(", ");
    const message = `Nur ${ALLOWED_FILES_LABEL} erlaubt. Nicht akzeptiert: ${rejectedNames}`;
    window.alert(message);
    setMessage(uploadMessage, message, "error");
  }

  renderPendingFiles();

  if (pendingFiles.length > 0) {
    setMessage(uploadMessage, `${pendingFiles.length} Datei(en) bereit zum Upload.`, "success");
    startUpload();
  }
}

function buildClipboardFileName(file, index) {
  const hasName = typeof file.name === "string" && file.name.trim().length > 0;
  if (hasName) {
    return file.name;
  }

  const mime = String(file.type || "").toLowerCase();
  const ext = mime.includes("/") ? mime.split("/")[1].replace(/[^a-z0-9]/g, "") : "bin";
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `clipboard-${stamp}-${index}.${ext || "bin"}`;
}

function getFilesFromClipboardEvent(event) {
  const items = Array.from(event.clipboardData?.items || []);
  const files = [];

  for (const item of items) {
    if (item.kind !== "file") {
      continue;
    }

    const blob = item.getAsFile();
    if (!blob) {
      continue;
    }

    const normalizedName = buildClipboardFileName(blob, files.length + 1);
    const file = new File([blob], normalizedName, {
      type: blob.type || "application/octet-stream",
      lastModified: Date.now()
    });
    files.push(file);
  }

  return files;
}

function uploadSingleFile(file) {
  return new Promise((resolve, reject) => {
    const fileKey = getFileKey(file);
    const body = new FormData();
    body.append("files", file);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/cases/${currentCaseId}/files`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = (event.loaded / event.total) * 100;
      updateQueueProgress(fileKey, percent, "Lädt...", "uploading");
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        let uploaded = null;
        try {
          const parsed = JSON.parse(xhr.responseText || "{}");
          uploaded = Array.isArray(parsed.uploaded) ? parsed.uploaded[0] : null;
        } catch {
          // Ignore JSON parse errors on success response.
        }
        updateQueueProgress(fileKey, 100, "Fertig", "done");
        resolve(uploaded);
        return;
      }

      if (OUTAGE_STATUSES.has(Number(xhr.status))) {
        showServiceAlert("Upload-Service derzeit gestört");
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
      updateQueueProgress(fileKey, 0, "Fehler", "error");
      reject(new Error(errorText));
    };

    xhr.onerror = () => {
      showServiceAlert("Keine Verbindung zum Backend");
      updateQueueProgress(fileKey, 0, "Fehler", "error");
      reject(new Error("Server nicht erreichbar."));
    };

    xhr.send(body);
  });
}

function renderAnalysisInQueueRow(fileKey, payload) {
  const row = uploadQueue.querySelector(`.queue-item[data-file-key="${CSS.escape(fileKey)}"]`);
  if (!(row instanceof HTMLElement)) {
    return;
  }

  const existing = row.querySelector(".queue-analysis");
  if (existing) {
    existing.remove();
  }

  const thinking = row.querySelector(".queue-ai-thinking");
  if (thinking) {
    thinking.remove();
  }

  const renderMentionBars = (count, tone) => {
    const safeCount = Math.max(0, Number(count) || 0);
    const cls = tone === "positive" ? "is-positive" : "is-negative";
    if (safeCount <= 0) {
      return `<span class="qa-dot-wrap"><span class="qa-dot-count">0</span></span>`;
    }
    return `<span class="qa-dot-wrap"><span class="qa-dot-track" aria-label="${safeCount}">${Array.from({ length: safeCount }, () => `<span class="qa-dot ${cls}" aria-hidden="true"></span>`).join("")}</span><span class="qa-dot-count">${safeCount}</span></span>`;
  };

  const docType = String(payload?.documentType || "").trim();
  const title = String(payload?.title || "").trim();
  const author = String(payload?.author || "").trim();
  const date = String(payload?.authoredDate || "").trim();
  const senderInstitution = String(payload?.senderInstitution || "").trim();
  const impactAssessment = String(payload?.impactAssessment || "").trim();
  const positiveMentions = Math.max(0, Number(payload?.positiveMentions || 0));
  const negativeMentions = Math.max(0, Number(payload?.negativeMentions || 0));
  const opposingPositiveMentions = Math.max(0, Number(payload?.opposingPositiveMentions || 0));
  const opposingNegativeMentions = Math.max(0, Number(payload?.opposingNegativeMentions || 0));
  const people = Array.isArray(payload?.people)
    ? payload.people.map((p) => String(p?.name || p || "").trim()).filter(Boolean)
    : [];

  if (!docType && !title && !author && !date && !senderInstitution && !impactAssessment && people.length === 0) {
    return;
  }

  const card = document.createElement("div");
  card.className = "queue-analysis";
  card.innerHTML = `
    ${docType ? `<span class="qa-tag">${docType}</span>` : ""}
    <div class="qa-grid">
      <span class="qa-field"><span class="qa-label">Titel</span>${title || "Unbekannt"}</span>
      <span class="qa-field"><span class="qa-label">Verfasser</span>${author || "Unbekannt"}</span>
      <span class="qa-field"><span class="qa-label">Datum</span>${date || "Unbekannt"}</span>
      <span class="qa-field"><span class="qa-label">Herkunft</span>${senderInstitution || "Unbekannt"}</span>
      <span class="qa-field"><span class="qa-label">Personen</span>${people.length > 0 ? people.join(" · ") : "Keine"}</span>
      ${impactAssessment ? `<span class="qa-field qa-wide"><span class="qa-label">Fazit</span>${impactAssessment}</span>` : ""}
    </div>
    <div class="qa-mentions">
      <div class="qa-persons-grid">
        <div class="qa-person-col">
          <div class="qa-person-col-label">Benachteiligte Person</div>
          <div class="qa-badge-rows">
            <div class="qa-badge-row"><span class="qa-badge-row-label is-positive">Positiv</span>${renderMentionBars(positiveMentions, "positive")}</div>
            <div class="qa-badge-row"><span class="qa-badge-row-label is-negative">Negativ</span>${renderMentionBars(negativeMentions, "negative")}</div>
          </div>
        </div>
        <div class="qa-person-col">
          <div class="qa-person-col-label">Gegenpartei</div>
          <div class="qa-badge-rows">
            <div class="qa-badge-row"><span class="qa-badge-row-label is-positive">Positiv</span>${renderMentionBars(opposingPositiveMentions, "positive")}</div>
            <div class="qa-badge-row"><span class="qa-badge-row-label is-negative">Negativ</span>${renderMentionBars(opposingNegativeMentions, "negative")}</div>
          </div>
        </div>
      </div>
    </div>
  `;
  row.appendChild(card);
}

async function triggerRealtimeAnalysis(fileId, fileName, fileKey) {
  if (!fileId) {
    return;
  }

  updateQueueProgress(fileKey, 100, "Analysiere...", "done");

  let response;
  try {
    response = await fetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}/analysis`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch {
    showServiceAlert("Analyse-Service derzeit nicht erreichbar");
    updateQueueProgress(fileKey, 100, "Fertig (Analyse später)", "done");
    return;
  }

  if (!response.ok) {
    if (OUTAGE_STATUSES.has(Number(response.status))) {
      showServiceAlert("Analyse-Service derzeit gestört");
    }
    updateQueueProgress(fileKey, 100, "Fertig (Analyse später)", "done");
    return;
  }

  const payload = await response.json().catch(() => ({}));
  const hasExtractedData = Boolean(payload?.title || payload?.author || payload?.authoredDate || payload?.documentType)
    || (Array.isArray(payload?.people) && payload.people.length > 0);

  if (hasExtractedData) {
    updateQueueProgress(fileKey, 100, "Analysiert", "done");
    renderAnalysisInQueueRow(fileKey, payload);
    return;
  }

  updateQueueProgress(fileKey, 100, "Fertig", "done");
  if (payload?.message) {
    const name = decodeUtf8Safe(fileName || "Datei");
    setMessage(uploadMessage, `${name}: ${payload.message}`, "success");
  }
}

async function startUpload() {
  if (isUploading) {
    return;
  }

  if (pendingFiles.length === 0) {
    return;
  }

  isUploading = true;
  const filesToUpload = [...pendingFiles];
  pendingFiles = [];

  let successCount = 0;
  for (const file of filesToUpload) {
    try {
      const uploadedMeta = await uploadSingleFile(file);
      const fileKey = getFileKey(file);
      if (uploadedMeta?.id) {
        setRowUploadedFileId(fileKey, uploadedMeta.id);
        await triggerRealtimeAnalysis(uploadedMeta.id, uploadedMeta.original_name || file.name, fileKey);
      }
      successCount += 1;
    } catch (error) {
      setMessage(uploadMessage, error.message || "Upload fehlgeschlagen.", "error");
      isUploading = false;
      return;
    }
  }

  totalUploadedCount += successCount;
  setMessage(uploadMessage, `${totalUploadedCount} Datei(en) erfolgreich hochgeladen.`, "success");
  fileInput.value = "";
  isUploading = false;

  if (pendingFiles.length > 0) {
    startUpload();
  }
}

async function deleteUploadedFile(fileId, fileKey) {
  let response;
  try {
    response = await fetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch {
    showServiceAlert("Keine Verbindung zum Backend");
    setMessage(uploadMessage, "Backend nicht erreichbar.", "error");
    return;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (OUTAGE_STATUSES.has(Number(response.status))) {
      showServiceAlert("Lösch-Service derzeit gestört");
    }
    setMessage(uploadMessage, payload.error || "Datei konnte nicht gelöscht werden.", "error");
    return;
  }

  const row = uploadQueue.querySelector(`.queue-item[data-file-key="${CSS.escape(fileKey)}"]`);
  if (row) {
    row.remove();
  }

  totalUploadedCount = Math.max(0, totalUploadedCount - 1);
  setMessage(uploadMessage, `${totalUploadedCount} Datei(en) erfolgreich hochgeladen.`, "success");
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
});

document.addEventListener("paste", (event) => {
  const files = getFilesFromClipboardEvent(event);
  if (files.length === 0) {
    return;
  }

  event.preventDefault();
  addPendingFiles(files);
  dropzone.classList.add("paste-flash");
  window.setTimeout(() => dropzone.classList.remove("paste-flash"), 500);
});

uploadQueue.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const deleteButton = target.closest(".queue-delete");
  if (!deleteButton) {
    return;
  }

  const row = deleteButton.closest(".queue-item");
  if (!(row instanceof HTMLElement)) {
    return;
  }

  const fileId = row.dataset.fileId;
  const fileKey = row.dataset.fileKey;
  if (!fileId || !fileKey) {
    return;
  }

  await deleteUploadedFile(fileId, fileKey);
});

goToListBtn?.addEventListener("click", () => {
  window.location.href = "/files.html";
});

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem("token");
  sessionStorage.removeItem("currentCaseId");
  window.location.href = "/";
});

copyrightYearEl.textContent = String(new Date().getFullYear());

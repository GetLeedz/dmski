const token = sessionStorage.getItem("token");
if (!token) {
  window.location.replace("/");
}

const currentCaseId = String(sessionStorage.getItem("currentCaseId") || "").trim();
if (!/^\d{6}$/.test(currentCaseId)) {
  window.location.replace("/dashboard.html");
}

const authGate = document.getElementById("authGate");
const dashboardMain = document.getElementById("dashboardMain");
if (token && dashboardMain) {
  dashboardMain.style.display = "";
  if (authGate) authGate.remove();
}

const host = String(window.location.hostname || "").toLowerCase();
const isLocalHost = host === "localhost"
  || host === "127.0.0.1"
  || host === "0.0.0.0"
  || host === "::1"
  || host.endsWith(".local")
  || /^192\.168\./.test(host)
  || /^10\./.test(host)
  || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);

const API_BASE = "https://lively-reverence-production-def3.up.railway.app/api";

// ── Modern Modal System (replaces window.alert / window.confirm) ──
// Returns: "confirm" | "cancel" | "abort" (or true/false for simple modals)
function dmskiModal({ icon = "warn", title, body, confirmLabel = "OK", cancelLabel, abortLabel, confirmClass = "is-primary" }) {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "dmski-modal-overlay";
    const iconHtml = icon === "warn" ? "⚠️" : icon === "error" ? "❌" : icon === "info" ? "ℹ️" : icon === "success" ? "✅" : icon;
    const iconClass = icon === "warn" ? "is-warn" : icon === "error" ? "is-error" : "is-info";
    const abortBtn = abortLabel ? `<button class="dmski-modal-btn is-danger-outline" data-action="abort">${abortLabel}</button>` : "";
    const cancelBtn = cancelLabel ? `<button class="dmski-modal-btn is-secondary" data-action="cancel">${cancelLabel}</button>` : "";
    overlay.innerHTML = `
      <div class="dmski-modal">
        <div class="dmski-modal-icon ${iconClass}">${iconHtml}</div>
        <p class="dmski-modal-title">${title}</p>
        <div class="dmski-modal-body">${body}</div>
        <div class="dmski-modal-actions">
          ${abortBtn}
          ${cancelBtn}
          <button class="dmski-modal-btn ${confirmClass}" data-action="confirm">${confirmLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const hasThreeActions = abortLabel && cancelLabel;
    overlay.addEventListener("click", (e) => {
      const action = e.target.closest("[data-action]")?.dataset.action;
      if (!action) return;
      overlay.remove();
      if (hasThreeActions) { resolve(action); }
      else { resolve(action === "confirm"); }
    });
    overlay.querySelector("[data-action=confirm]").focus();
  });
}

const OUTAGE_STATUSES = new Set([502, 503, 504]);
let serviceAlertEl = null;
let authRedirectStarted = false;

// ── Duplicate detection: load existing filenames from case ──
let existingFileNames = new Set();
async function loadExistingFileNames() {
  try {
    const res = await fetch(`${API_BASE}/cases/${currentCaseId}/files`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (res.ok) {
      const data = await res.json();
      const files = Array.isArray(data) ? data : (Array.isArray(data.files) ? data.files : []);
      existingFileNames = new Set(files.map(f => (f.original_name || "").toLowerCase().trim()));
    }
  } catch { /* ignore */ }
}
loadExistingFileNames();

function buildLoginRedirectMessage(detail) {
  const normalized = String(detail || "").trim().toLowerCase();
  if (normalized.includes("nicht autorisiert")) {
    return "Bitte erneut anmelden.";
  }
  return "Sitzung abgelaufen. Bitte erneut anmelden.";
}

function redirectToLogin(detail) {
  if (authRedirectStarted) {
    return;
  }

  authRedirectStarted = true;
  sessionStorage.removeItem("token");
  sessionStorage.removeItem("currentCaseId");
  sessionStorage.setItem("loginMessage", buildLoginRedirectMessage(detail));
  window.location.replace("/");
}

async function apiFetch(input, init) {
  const response = await fetch(input, init);
  if (response.status !== 401) {
    return response;
  }

  let payload = null;
  try {
    payload = await response.clone().json();
  } catch {
    payload = null;
  }

  redirectToLogin(payload?.error);
  throw new Error("AUTH_REDIRECT");
}

function handleUnauthorizedStatus(status, responseText) {
  if (Number(status) !== 401) {
    return false;
  }

  let payload = null;
  try {
    payload = JSON.parse(responseText || "{}");
  } catch {
    payload = null;
  }

  redirectToLogin(payload?.error);
  return true;
}

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
const cancelUploadBtn = document.getElementById("cancelUploadBtn");

cancelUploadBtn?.addEventListener("click", () => {
  cancelUpload();
  cancelUploadBtn.hidden = true;
});
const logoutBtn = document.getElementById("logoutBtn");
const copyrightYearEl = document.getElementById("copyrightYear");

let pendingFiles = [];
let isUploading = false;
let totalUploadedCount = 0;
let currentCaseProtectedLabel = "Fokus-Partei";
let currentCaseOpposingLabel = "Gegenpartei";
let currentCaseProtectedKeywords = "";
let currentCaseOpposingKeywords = "";
const ALLOWED_EXTENSIONS = new Set([
  "pdf","doc","docx","xls","xlsx","ppt","pptx","txt","csv",
  "jpg","jpeg","png","tiff","tif","webp","heic","heif","gif","bmp",
  "mov","mp4","avi","mkv","webm","3gp",
  "mp3","m4a","wav","aac","ogg"
]);
const ALLOWED_FILES_LABEL = "PDF, DOCX, XLSX, PPTX, TXT, JPG, PNG, TIFF, HEIC, WEBP, MOV, MP4, AVI, MKV, MP3, WAV, M4A";

activeCaseBanner.textContent = `WICHTIG: Du arbeitest im Fall ${currentCaseId}`;
workspaceHint.textContent = "Files werden direkt hochgeladen: Drag&Drop, Klick-Auswahl oder Einfügen mit Ctrl+V.";

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

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function normalizePartyLabel(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) {
    return fallback;
  }

  const firstAlias = raw.split(",")[0].trim();
  return firstAlias || fallback;
}

async function loadCasePartyLabels() {
  try {
    const response = await apiFetch(`${API_BASE}/cases`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      return;
    }

    const payload = await response.json().catch(() => ({}));
    const list = Array.isArray(payload?.cases) ? payload.cases : [];
    const active = list.find((item) => String(item?.id || "") === currentCaseId);
    if (!active) {
      return;
    }

    currentCaseProtectedLabel = "Fokus-Partei";
    currentCaseOpposingLabel = "Gegenpartei";
    currentCaseProtectedKeywords = String(active?.protected_person_name || "").trim();
    currentCaseOpposingKeywords = String(active?.opposing_party || "").trim();
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
    // Keep defaults when lookup fails.
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
    uploadQueue.prepend(row);
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

async function addPendingFiles(newFiles) {
  const { accepted, rejected } = splitAcceptedFiles(newFiles);
  const existingKeys = new Set(pendingFiles.map((f) => getFileKey(f)));

  const duplicates = [];
  const fresh = [];

  for (const f of accepted) {
    const key = getFileKey(f);
    if (existingKeys.has(key)) continue;
    if (existingFileNames.has((f.name || "").toLowerCase().trim())) {
      duplicates.push(f);
    } else {
      fresh.push(f);
      existingKeys.add(key);
    }
  }

  // Handle duplicates with modern 3-button modal
  for (const f of duplicates) {
    const name = decodeUtf8Safe(f.name);
    const action = await dmskiModal({
      icon: "warn",
      title: "Datei existiert bereits",
      body: `<strong>${name}</strong> ist bereits im Dossier vorhanden.`,
      confirmLabel: "Ersetzen",
      cancelLabel: "Überspringen",
      abortLabel: "Abbrechen",
      confirmClass: "is-gold"
    });
    if (action === "confirm") {
      fresh.push(f);
      existingKeys.add(getFileKey(f));
    } else if (action === "abort") {
      // Cancel entire upload
      setMessage(uploadMessage, "Upload abgebrochen.", "error");
      return;
    }
    // "cancel" = skip this file, continue with next
  }

  for (const f of fresh) {
    pendingFiles.push(f);
  }

  if (rejected.length > 0) {
    const rejectedNames = rejected.map((f) => decodeUtf8Safe(f.name)).join(", ");
    await dmskiModal({
      icon: "error",
      title: "Dateityp nicht erlaubt",
      body: `Nur <strong>${ALLOWED_FILES_LABEL}</strong> erlaubt.<br>Nicht akzeptiert: ${rejectedNames}`,
      confirmLabel: "Verstanden"
    });
    setMessage(uploadMessage, `Nur ${ALLOWED_FILES_LABEL} erlaubt.`, "error");
  }

  renderPendingFiles();

  if (pendingFiles.length > 0) {
    setMessage(uploadMessage, `${pendingFiles.length} File(s) bereit zum Upload.`, "success");
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

let activeXhr = null;
let uploadCancelled = false;

function cancelUpload() {
  uploadCancelled = true;
  if (activeXhr) {
    activeXhr.abort();
    activeXhr = null;
  }
  pendingFiles = [];
  isUploading = false;
  setMessage(uploadMessage, "Upload abgebrochen.", "error");
  // Mark pending rows as cancelled
  uploadQueue.querySelectorAll(".queue-item.uploading").forEach(row => {
    const state = row.querySelector(".queue-state");
    if (state) state.textContent = "Abgebrochen";
    row.classList.remove("uploading");
    row.classList.add("error");
  });
}

function uploadSingleFile(file) {
  return new Promise((resolve, reject) => {
    if (uploadCancelled) { reject(new Error("CANCELLED")); return; }
    const fileKey = getFileKey(file);
    const body = new FormData();
    body.append("files", file);

    const xhr = new XMLHttpRequest();
    activeXhr = xhr;
    xhr.open("POST", `${API_BASE}/cases/${currentCaseId}/files`);
    xhr.setRequestHeader("Authorization", `Bearer ${token}`);

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = (event.loaded / event.total) * 100;
      updateQueueProgress(fileKey, percent, "Lädt...", "uploading");
    };

    xhr.onabort = () => {
      activeXhr = null;
      updateQueueProgress(fileKey, 0, "Abgebrochen", "error");
      reject(new Error("CANCELLED"));
    };

    xhr.onload = () => {
      activeXhr = null;
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

      if (handleUnauthorizedStatus(xhr.status, xhr.responseText)) {
        reject(new Error("AUTH_REDIRECT"));
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
  const analysisEngineVersion = String(payload?.analysisEngineVersion || "").trim();
  const backendStartedAt = String(payload?.backendStartedAt || "").trim();
  const protectedKeywords = currentCaseProtectedKeywords || "Nicht gesetzt";
  const opposingKeywords = currentCaseOpposingKeywords || "Nicht gesetzt";
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
      <span class="qa-field"><span class="qa-label">Personen</span><span class="qa-field-value">${people.length > 0 ? people.join(" · ") : "Keine"}</span></span>
      ${analysisEngineVersion || backendStartedAt ? `<span class="qa-field qa-wide"><span class="qa-label">Engine</span><span class="qa-field-value">${escapeHtml(analysisEngineVersion || "unbekannt")}${backendStartedAt ? ` · Instanz ${escapeHtml(backendStartedAt)}` : ""}</span></span>` : ""}
      ${impactAssessment ? `<span class="qa-field qa-wide"><span class="qa-label">Fazit</span><span class="qa-field-value">${impactAssessment}</span></span>` : ""}
    </div>
    <div class="qa-mentions">
      <div class="qa-persons-grid">
        <div class="qa-person-col">
          <div class="qa-person-col-label"><span class="qa-person-role">${escapeHtml(currentCaseProtectedLabel)}</span><span class="qa-person-keywords">${escapeHtml(protectedKeywords)}</span></div>
          <div class="qa-badge-rows">
            <div class="qa-badge-row"><span class="qa-badge-row-label is-positive">Positiv</span>${renderMentionBars(positiveMentions, "positive")}</div>
            <div class="qa-badge-row"><span class="qa-badge-row-label is-negative">Negativ</span>${renderMentionBars(negativeMentions, "negative")}</div>
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
    response = await apiFetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}/analysis?refresh=true`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
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
  uploadCancelled = false;
  if (cancelUploadBtn) cancelUploadBtn.hidden = false;
  const filesToUpload = [...pendingFiles];
  pendingFiles = [];

  let successCount = 0;
  for (const file of filesToUpload) {
    if (uploadCancelled) break;
    try {
      const uploadedMeta = await uploadSingleFile(file);
      const fileKey = getFileKey(file);
      if (uploadedMeta?.id) {
        setRowUploadedFileId(fileKey, uploadedMeta.id);
        existingFileNames.add((uploadedMeta.original_name || file.name).toLowerCase().trim());
        await triggerRealtimeAnalysis(uploadedMeta.id, uploadedMeta.original_name || file.name, fileKey);
      }
      successCount += 1;
    } catch (error) {
      if (error instanceof Error && error.message === "CANCELLED") {
        break;
      }
      if (error instanceof Error && error.message === "AUTH_REDIRECT") {
        isUploading = false;
        return;
      }
      setMessage(uploadMessage, error.message || "Upload fehlgeschlagen.", "error");
      isUploading = false;
      return;
    }
  }

  if (uploadCancelled) {
    if (successCount > 0) setMessage(uploadMessage, `${successCount} File(s) hochgeladen, Rest abgebrochen.`, "error");
  } else {
    totalUploadedCount += successCount;
    setMessage(uploadMessage, `${totalUploadedCount} File(s) erfolgreich hochgeladen.`, "success");
  }
  fileInput.value = "";
  isUploading = false;
  if (cancelUploadBtn) cancelUploadBtn.hidden = true;

  if (pendingFiles.length > 0) {
    startUpload();
  }
}

async function deleteUploadedFile(fileId, fileKey) {
  let response;
  try {
    response = await apiFetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
    showServiceAlert("Keine Verbindung zum Backend");
    setMessage(uploadMessage, "Backend nicht erreichbar.", "error");
    return;
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (OUTAGE_STATUSES.has(Number(response.status))) {
      showServiceAlert("Lösch-Service derzeit gestört");
    }
    setMessage(uploadMessage, payload.error || "File konnte nicht gel\u00f6scht werden.", "error");
    return;
  }

  const row = uploadQueue.querySelector(`.queue-item[data-file-key="${CSS.escape(fileKey)}"]`);
  if (row) {
    row.remove();
  }

  totalUploadedCount = Math.max(0, totalUploadedCount - 1);
  setMessage(uploadMessage, `${totalUploadedCount} File(s) erfolgreich hochgeladen.`, "success");
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

if (copyrightYearEl) copyrightYearEl.textContent = String(new Date().getFullYear());
loadCasePartyLabels();


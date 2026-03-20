const token = sessionStorage.getItem("token");
if (!token) {
  window.location.href = "/";
}

const currentCaseId = String(sessionStorage.getItem("currentCaseId") || "").trim();
if (!/^\d{6}$/.test(currentCaseId)) {
  window.location.href = "/dashboard.html";
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

const filesTableBody = document.getElementById("filesTableBody");
const listTitle = document.getElementById("listTitle");
const fileTypeFilter = document.getElementById("fileTypeFilter");
const dateFromFilter = document.getElementById("dateFromFilter");
const listMessage = document.getElementById("listMessage");
const undoBar = document.getElementById("undoBar");
const previewModal = document.getElementById("previewModal");
const previewModalTitle = document.getElementById("previewModalTitle");
const previewModalViewport = document.getElementById("previewModalViewport");
const zoomOutBtn = document.getElementById("zoomOutBtn");
const zoomInBtn = document.getElementById("zoomInBtn");
const zoomMaxBtn = document.getElementById("zoomMaxBtn");
const zoomResetBtn = document.getElementById("zoomResetBtn");
const zoomLevel = document.getElementById("zoomLevel");
const closePreviewBtn = document.getElementById("closePreviewBtn");
const goToUploadBtn = document.getElementById("goToUploadBtn");
const toggleMultiDeleteBtn = document.getElementById("toggleMultiDeleteBtn");
const backToCasesBtn = document.getElementById("backToCasesBtn");
const deleteCaseBtn = document.getElementById("deleteCaseBtn");
const logoutBtn = document.getElementById("logoutBtn");
const copyrightYearEl = document.getElementById("copyrightYear");
const selectAllHeader = document.getElementById("selectAllHeader");
const selectAllCheckbox = document.getElementById("selectAllCheckbox");
const multiDeleteBar = document.getElementById("multiDeleteBar");
const multiDeleteCount = document.getElementById("multiDeleteCount");
const executeMultiDeleteBtn = document.getElementById("executeMultiDeleteBtn");
const cancelMultiDeleteBtn = document.getElementById("cancelMultiDeleteBtn");

let allFiles = [];
const previewUrlCache = new Map();
const previewPromiseCache = new Map();
const analysisCache = new Map();
const analysisPromiseCache = new Map();
let modalZoom = 1;
let pendingDelete = null;
let isMultiDeleteMode = false;
const selectedFileIds = new Set();
let currentCaseProtectedPerson = "";
let currentCaseName = "";

listTitle.textContent = `Dateiliste für Fall ${currentCaseId}`;

function setMessage(el, text, type) {
  el.textContent = text;
  el.classList.remove("error", "success");
  if (type) {
    el.classList.add(type);
  }
}

function formatDate(value) {
  const date = new Date(value);
  const dateStr = date.toLocaleString("de-CH", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const timeStr = date.toLocaleString("de-CH", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  return `${dateStr} ${timeStr}`;
}

function formatSwissAnalysisDate(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  if (/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) {
    return raw;
  }

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return `${iso[3]}.${iso[2]}.${iso[1]}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString("de-CH", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    });
  }

  return raw;
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

  const promise = fetch(`${API_BASE}/cases/${currentCaseId}/files/${file.id}/preview`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  previewPromiseCache.set(file.id, promise);

  let response;
  try {
    response = await promise;
  } catch {
    previewPromiseCache.delete(file.id);
    showServiceAlert("Keine Verbindung zum Backend");
    setMessage(listMessage, "Backend nicht erreichbar. Bitte später erneut versuchen.", "error");
    return null;
  }
  previewPromiseCache.delete(file.id);

  if (!response.ok) {
    if (OUTAGE_STATUSES.has(Number(response.status))) {
      showServiceAlert("Vorschau-Service derzeit gestört");
    }
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

function normalizeTitleText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function normalizePeople(people) {
  if (!Array.isArray(people)) {
    return [];
  }

  return people
    .map((entry) => {
      if (typeof entry === "string") {
        const name = normalizeTitleText(entry);
        return name ? { name, affiliation: "Privatperson" } : null;
      }

      const name = normalizeTitleText(entry?.name || entry?.fullName || "");
      const affiliation = normalizeTitleText(entry?.affiliation || "Privatperson");
      if (!name) {
        return null;
      }
      return { name, affiliation: affiliation || "Privatperson" };
    })
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeImpactRanking(entries) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .map((entry) => {
      const name = normalizeTitleText(entry?.name);
      if (!name) {
        return null;
      }
      return {
        name,
        impact: normalizeTitleText(entry?.impact),
        count: Number.isFinite(Number(entry?.count)) ? Number(entry.count) : 0,
        items: Array.isArray(entry?.items)
          ? entry.items.map((item) => normalizeTitleText(item)).filter(Boolean)
          : []
      };
    })
    .filter(Boolean);
}

async function getDocumentAnalysis(file) {
  if (analysisCache.has(file.id)) {
    return analysisCache.get(file.id);
  }

  if (analysisPromiseCache.has(file.id)) {
    return analysisPromiseCache.get(file.id);
  }

  const request = fetch(`${API_BASE}/cases/${currentCaseId}/files/${file.id}/analysis`, {
    headers: { Authorization: `Bearer ${token}` }
  })
    .then(async (response) => {
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        return {
          status: "error",
          title: "",
          message: payload.error || "Analyse konnte nicht geladen werden."
        };
      }

      const payload = await response.json().catch(() => ({}));
      return {
        status: payload.status || "ok",
        title: normalizeTitleText(payload.title),
        author: normalizeTitleText(payload.author),
        authoredDate: normalizeTitleText(payload.authoredDate),
        people: normalizePeople(payload.people),
        disadvantagedPerson: normalizeTitleText(payload.disadvantagedPerson),
        senderInstitution: normalizeTitleText(payload.senderInstitution),
        impactAssessment: normalizeTitleText(payload.impactAssessment),
        impactRanking: normalizeImpactRanking(payload.impactRanking),
        message: normalizeTitleText(payload.message)
      };
    })
    .catch(() => ({
      status: "error",
      title: "",
      author: "",
      authoredDate: "",
      people: [],
      disadvantagedPerson: "",
      senderInstitution: "",
      impactAssessment: "",
      impactRanking: [],
      message: "Analyse konnte nicht geladen werden."
    }));

  analysisPromiseCache.set(file.id, request);
  const result = await request;
  analysisPromiseCache.delete(file.id);
  analysisCache.set(file.id, result);
  return result;
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
  const box = filesTableBody.querySelector(`.row-preview-box[data-file-id="${file.id}"]`);
  if (!(box instanceof HTMLElement)) {
    return;
  }

  const fileType = resolveFileType(file);
  if (!["pdf", "png", "jpg"].includes(fileType.className)) {
    box.innerHTML = '<span class="row-preview-empty">Keine Vorschau</span>';
    return;
  }

  box.innerHTML = '<div class="row-preview-loading"><span class="spinner spinner--preview" aria-label="Vorschau wird geladen"></span></div>';
  const previewUrl = await getPreviewUrl(file);
  if (!previewUrl) {
    box.innerHTML = '<span class="row-preview-empty">Neu hochladen</span>';
    return;
  }

  if (fileType.className === "pdf") {
    box.innerHTML = `<iframe class="row-preview-frame" src="${previewUrl}" title="PDF Vorschau ${decodeUtf8Safe(file.original_name)}"></iframe>`;
    return;
  }

  box.innerHTML = `<img class="row-preview-image" src="${previewUrl}" alt="Vorschau ${decodeUtf8Safe(file.original_name)}" />`;
}

async function loadRowAnalysis(file) {
  const box = filesTableBody.querySelector(`.analysis-box[data-file-id="${file.id}"]`);
  if (!(box instanceof HTMLElement)) {
    return;
  }

  box.innerHTML = `
    <div class="analysis-loading">
      <span class="spinner spinner--ai" aria-label="KI analysiert"></span>
      <span class="analysis-loading-text">KI analysiert Dokument&hellip;<br /><small>Das kann bei Bildern l&auml;nger dauern.</small></span>
    </div>`;
  const analysis = await getDocumentAnalysis(file);

  const toDisplayName = (value) => {
    if (typeof value === "string") {
      return normalizeTitleText(value);
    }
    if (value && typeof value === "object") {
      if (typeof value.name === "string") {
        return normalizeTitleText(value.name);
      }
      if (typeof value.fullName === "string") {
        return normalizeTitleText(value.fullName);
      }
      const first = typeof value.firstName === "string" ? normalizeTitleText(value.firstName) : "";
      const last = typeof value.lastName === "string" ? normalizeTitleText(value.lastName) : "";
      return normalizeTitleText(`${first} ${last}`);
    }
    return "";
  };

  const people = Array.isArray(analysis.people)
    ? analysis.people
      .map((entry) => (typeof entry === "string"
        ? { name: toDisplayName(entry), affiliation: "Privatperson" }
        : { name: toDisplayName(entry), affiliation: normalizeTitleText(entry?.affiliation || "Privatperson") }))
      .filter((entry) => entry.name)
    : [];

  const peopleMarkup = people.length > 0
    ? `<ul class="analysis-people">${people.map((person) => `<li><span>${person.name}</span><span class="analysis-person-affiliation">${person.affiliation}</span></li>`).join("")}</ul>`
    : '<p class="analysis-value muted">Keine eindeutigen Personen erkannt</p>';

  const titleMarkup = analysis.title
    ? `<p class="analysis-value analysis-title">${analysis.title}</p>`
    : '<p class="analysis-value muted">Nicht erkannt</p>';

  const authorMarkup = analysis.author
    ? `<p class="analysis-value">${analysis.author}</p>`
    : '<p class="analysis-value muted">Nicht erkannt</p>';

  const swissAuthoredDate = formatSwissAnalysisDate(analysis.authoredDate);
  const dateMarkup = swissAuthoredDate
    ? `<p class="analysis-value">${swissAuthoredDate}</p>`
    : '<p class="analysis-value muted">Nicht erkannt</p>';

  const disadvantagedMarkup = analysis.disadvantagedPerson
    ? `<p class="analysis-value">${analysis.disadvantagedPerson}</p>`
    : '<p class="analysis-value muted">Nicht erkannt</p>';

  const senderInstitutionMarkup = analysis.senderInstitution
    ? `<p class="analysis-value">${analysis.senderInstitution}</p>`
    : '<p class="analysis-value muted">Nicht erkannt</p>';

  const impactAssessmentMarkup = analysis.impactAssessment
    ? `<p class="analysis-value">${analysis.impactAssessment}</p>`
    : '<p class="analysis-value muted">Nicht erkannt</p>';

  const impactRankingItems = Array.isArray(analysis.impactRanking)
    ? analysis.impactRanking
      .map((entry) => ({
        name: normalizeTitleText(entry?.name),
        impact: normalizeTitleText(entry?.impact),
        count: typeof entry?.count === "number" ? entry.count : 0,
        items: Array.isArray(entry?.items) ? entry.items.filter((s) => typeof s === "string" && s.trim()) : []
      }))
      .filter((entry) => entry.name)
    : [];

  const impactRankingMarkup = impactRankingItems.length > 0
    ? `<ul class="analysis-people">${impactRankingItems.map((entry) => {
        const countBadge = entry.count > 0 ? ` <span class="impact-count">${entry.count}</span>` : "";
        const impactClass = (entry.impact || "").toLowerCase() === "benachteiligt" ? "analysis-person-affiliation impact-badge-benachteiligt" : "analysis-person-affiliation";
        const itemsList = entry.items.length > 0
          ? `<ul class="impact-items">${entry.items.map((it) => `<li>«${it}»</li>`).join("")}</ul>`
          : "";
        return `<li class="impact-entry"><div class="impact-entry-header"><span>${entry.name}${countBadge}</span><span class="${impactClass}">${entry.impact}</span></div>${itemsList}</li>`;
      }).join("")}</ul>`
    : '<p class="analysis-value muted">Keine Einstufung</p>';

  const protectedName = normalizeTitleText(currentCaseProtectedPerson);
  const protectedEntry = protectedName
    ? impactRankingItems.find((entry) => entry.name.toLowerCase() === protectedName.toLowerCase())
    : null;
  const protectedCount = protectedEntry ? Math.max(0, Number(protectedEntry.count || 0)) : 0;
  const protectedStatusMarkup = !protectedName
    ? '<p class="analysis-value muted">Keine Fallperson definiert</p>'
    : protectedCount > 0
      ? `<p class="analysis-value"><strong>Ja</strong> · ${protectedCount} Vorfall${protectedCount === 1 ? "" : "e"}</p>`
      : '<p class="analysis-value">Nein · 0 Vorfälle</p>';

  const hintMarkup = analysis.message
    ? `<p class="analysis-hint">${analysis.message}</p>`
    : "";

  box.innerHTML = `
    <div class="analysis-section">
      <p class="analysis-label">Dokumenttitel</p>
      ${titleMarkup}
    </div>
    <div class="analysis-section">
      <p class="analysis-label">Verfasser</p>
      ${authorMarkup}
    </div>
    <div class="analysis-section">
      <p class="analysis-label">Datum Verfassung</p>
      ${dateMarkup}
    </div>
    <div class="analysis-section">
      <p class="analysis-label">Personen im Dokument</p>
      ${peopleMarkup}
    </div>
    <div class="analysis-section">
      <p class="analysis-label">Wer wird benachteiligt</p>
      ${disadvantagedMarkup}
    </div>
    <div class="analysis-section">
      <p class="analysis-label">Herkunft Schreiben</p>
      ${senderInstitutionMarkup}
    </div>
    <div class="analysis-section">
      <p class="analysis-label">KI Bewertung</p>
      ${impactAssessmentMarkup}
    </div>
    <div class="analysis-section">
      <p class="analysis-label">Gewichtung Personen</p>
      ${impactRankingMarkup}
    </div>
    <div class="analysis-section">
      <p class="analysis-label">Fallperson benachteiligt</p>
      ${protectedStatusMarkup}
    </div>
    ${hintMarkup}
  `;
}

function renderFiles(files) {
  filesTableBody.innerHTML = "";

  if (!files || files.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td colspan=\"3\">Keine Dateien für die gewählten Filter gefunden.</td>";
    filesTableBody.appendChild(tr);
    return;
  }

  for (const file of files) {
    const fileType = resolveFileType(file);
    const displayName = decodeUtf8Safe(file.original_name);
    const tr = document.createElement("tr");
    const isSelected = selectedFileIds.has(file.id);
    const checkboxClass = isMultiDeleteMode ? "checkbox-col" : "checkbox-col hidden";
    tr.dataset.fileId = file.id;
    tr.className = "file-row";
    if (isMultiDeleteMode) {
      tr.classList.add("multi-delete-row");
    }
    if (isSelected) {
      tr.classList.add("is-selected");
    }
    tr.innerHTML = `
      <td class="${checkboxClass}"><input type="checkbox" class="file-checkbox" data-file-id="${file.id}" ${isSelected ? "checked" : ""} /></td>
      <td class="preview-cell" data-file-id="${file.id}" title="Klicken für grosse Vorschau">
        <div class="preview-topline">
          <div class="preview-doc-id">Doc ID: ${compactDocId(file.id)}</div>
          <div class="row-actions">
            <button type="button" class="btn-inline download" data-action="download" data-id="${file.id}">Download</button>
            <button type="button" class="btn-inline delete" data-action="delete" data-id="${file.id}">Löschen</button>
          </div>
        </div>
        <div class="preview-timestamp">${formatDate(file.uploaded_at)}</div>
        <div class="row-preview-box" data-file-id="${file.id}"><div class="row-preview-loading"><span class="spinner spinner--preview" aria-label="Vorschau wird geladen"></span></div></div>
        <div class="preview-filename">${displayName}</div>
        <div class="preview-meta-row">
          <span class="file-icon ${fileType.className}">${fileType.label}</span>
          <span class="preview-size">${formatSizeKB(file.size_bytes)} KB</span>
        </div>
      </td>
      <td class="analysis-cell">
        <div class="analysis-box" data-file-id="${file.id}"></div>
      </td>
    `;
    filesTableBody.appendChild(tr);
  }

  for (const file of files) {
    void loadRowPreview(file);
    void loadRowAnalysis(file);
  }
}

function applyMultiDeleteUiState() {
  selectAllHeader.classList.toggle("hidden", !isMultiDeleteMode);
  multiDeleteBar.classList.toggle("hidden", !isMultiDeleteMode);
  toggleMultiDeleteBtn.classList.toggle("active", isMultiDeleteMode);
}

function hideUndoBar() {
  undoBar.classList.add("hidden");
  undoBar.textContent = "";
}

function showUndoBar(fileName) {
  undoBar.classList.remove("hidden");
  undoBar.innerHTML = `
    <span>${decodeUtf8Safe(fileName)} wurde entfernt. Rückgängig möglich (5s).</span>
    <button id="undoDeleteBtn" type="button" class="undo-btn">Rückgängig</button>
  `;

  const undoBtn = document.getElementById("undoDeleteBtn");
  undoBtn?.addEventListener("click", () => {
    if (!pendingDelete) {
      hideUndoBar();
      return;
    }

    clearTimeout(pendingDelete.timerId);
    allFiles = [pendingDelete.file, ...allFiles];
    allFiles.sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());
    renderFiles(filterFiles(allFiles));
    setMessage(listMessage, "Löschen rückgängig gemacht.", "success");
    pendingDelete = null;
    hideUndoBar();
  });
}

async function commitDelete(fileId) {
  const response = await fetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Datei konnte nicht gelöscht werden.");
  }
}

async function flushPendingDelete() {
  if (!pendingDelete) {
    return;
  }

  const snapshot = pendingDelete;
  pendingDelete = null;
  hideUndoBar();

  try {
    await commitDelete(snapshot.file.id);

    const cachedUrl = previewUrlCache.get(snapshot.file.id);
    if (cachedUrl) {
      URL.revokeObjectURL(cachedUrl);
      previewUrlCache.delete(snapshot.file.id);
    }
    previewPromiseCache.delete(snapshot.file.id);
    analysisCache.delete(snapshot.file.id);
    analysisPromiseCache.delete(snapshot.file.id);
    setMessage(listMessage, "Datei endgültig gelöscht.", "success");
  } catch (error) {
    allFiles = [snapshot.file, ...allFiles];
    allFiles.sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());
    renderFiles(filterFiles(allFiles));
    setMessage(listMessage, error.message || "Datei konnte nicht gelöscht werden.", "error");
  }
}

async function loadCaseContext() {
  try {
    const response = await fetch(`${API_BASE}/cases`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      return;
    }

    const payload = await response.json().catch(() => ({}));
    const cases = Array.isArray(payload?.cases) ? payload.cases : [];
    const active = cases.find((entry) => String(entry?.id || "") === currentCaseId);
    if (!active) {
      return;
    }

    currentCaseProtectedPerson = normalizeTitleText(active.protected_person_name || "");
    currentCaseName = normalizeTitleText(active.case_name || "");
    listTitle.textContent = currentCaseName
      ? `Dateiliste · ${currentCaseName} (${currentCaseId})`
      : `Dateiliste für Fall ${currentCaseId}`;
  } catch {
    // Keep default title when case context cannot be loaded.
  }
}

async function deleteCurrentCase() {
  const descriptor = currentCaseName || `Fall ${currentCaseId}`;
  const confirmed = window.confirm(`Bist du sicher, dass du "${descriptor}" inklusive aller Dateien löschen willst?`);
  if (!confirmed) {
    return;
  }

  if (pendingDelete) {
    clearTimeout(pendingDelete.timerId);
    await flushPendingDelete();
  }

  if (deleteCaseBtn instanceof HTMLButtonElement) {
    deleteCaseBtn.disabled = true;
  }

  try {
    const response = await fetch(`${API_BASE}/cases/${currentCaseId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Dossier konnte nicht gelöscht werden.");
    }

    sessionStorage.removeItem("currentCaseId");
    window.location.href = "/dashboard.html";
  } catch (error) {
    setMessage(listMessage, error.message || "Dossier konnte nicht gelöscht werden.", "error");
  } finally {
    if (deleteCaseBtn instanceof HTMLButtonElement) {
      deleteCaseBtn.disabled = false;
    }
  }
}

async function loadFiles() {
  let res;
  try {
    res = await fetch(`${API_BASE}/cases/${currentCaseId}/files`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch {
    showServiceAlert("Keine Verbindung zum Backend");
    setMessage(listMessage, "Backend nicht erreichbar. Bitte später erneut versuchen.", "error");
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    allFiles = data.files || [];
    renderFiles(filterFiles(allFiles));
    return;
  }

  if (OUTAGE_STATUSES.has(Number(res.status))) {
    showServiceAlert("Dateiliste derzeit nicht verfügbar");
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
  if (pendingDelete) {
    clearTimeout(pendingDelete.timerId);
    await flushPendingDelete();
  }

  const file = allFiles.find((entry) => entry.id === fileId);
  if (!file) {
    return;
  }

  if (triggerButton instanceof HTMLButtonElement) {
    triggerButton.disabled = true;
    triggerButton.textContent = "Lösche...";
  }

  allFiles = allFiles.filter((file) => file.id !== fileId);
  renderFiles(filterFiles(allFiles));

  const timerId = window.setTimeout(() => {
    void flushPendingDelete();
  }, 5000);

  pendingDelete = { file, timerId };
  showUndoBar(file.original_name);
  setMessage(listMessage, "Datei entfernt. Rückgängig möglich.", "success");
}

filesTableBody.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }

  const action = target.dataset.action;
  const fileId = target.dataset.id;
  const rowActions = target.closest(".row-actions");

  if (rowActions && action && fileId) {
    if (action === "download") {
      await downloadFile(fileId);
      return;
    }

    if (action === "delete") {
      void deleteFile(fileId, target);
      return;
    }
  }

  const previewCell = target.closest(".preview-cell");
  if (previewCell instanceof HTMLElement) {
    if (isMultiDeleteMode) {
      return;
    }
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

if (deleteCaseBtn instanceof HTMLButtonElement) {
  deleteCaseBtn.addEventListener("click", () => {
    void deleteCurrentCase();
  });
}

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

zoomMaxBtn.addEventListener("click", () => {
  updateModalZoom(4);
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

function toggleMultiDeleteMode() {
  isMultiDeleteMode = !isMultiDeleteMode;
  selectedFileIds.clear();
  selectAllCheckbox.checked = false;

  applyMultiDeleteUiState();
  renderFiles(filterFiles(allFiles));
  updateMultiDeleteCount();
}

function updateMultiDeleteCount() {
  const count = selectedFileIds.size;
  multiDeleteCount.textContent = count > 0 
    ? `${count} Datei${count === 1 ? "" : "en"} ausgewählt.`
    : "Keine Dateien ausgewählt.";
    
  executeMultiDeleteBtn.disabled = count === 0;
}

async function executeMultiDelete() {
  if (selectedFileIds.size === 0) {
    return;
  }

  if (pendingDelete) {
    clearTimeout(pendingDelete.timerId);
    await flushPendingDelete();
  }

  const filesToDelete = Array.from(selectedFileIds);
  const originalFiles = [...allFiles];
  
  executeMultiDeleteBtn.disabled = true;
  executeMultiDeleteBtn.textContent = "Löscht...";

  allFiles = allFiles.filter((f) => !selectedFileIds.has(f.id));
  renderFiles(filterFiles(allFiles));

  try {
    const promises = filesToDelete.map((fileId) =>
      fetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      }).then((res) => {
        if (!res.ok) {
          throw new Error(`Fehler beim Löschen von Datei ${fileId}`);
        }
      })
    );

    await Promise.all(promises);

    selectedFileIds.clear();
    selectAllCheckbox.checked = false;
    
    for (const fileId of filesToDelete) {
      const cachedUrl = previewUrlCache.get(fileId);
      if (cachedUrl) {
        URL.revokeObjectURL(cachedUrl);
        previewUrlCache.delete(fileId);
      }
      previewPromiseCache.delete(fileId);
      analysisCache.delete(fileId);
      analysisPromiseCache.delete(fileId);
    }

    setMessage(listMessage, `${filesToDelete.length} Datei${filesToDelete.length === 1 ? "" : "en"} gelöscht.`, "success");
    isMultiDeleteMode = false;
    applyMultiDeleteUiState();
    renderFiles(filterFiles(allFiles));
    updateMultiDeleteCount();
  } catch (error) {
    allFiles = originalFiles;
    renderFiles(filterFiles(allFiles));
    setMessage(listMessage, error.message || "Fehler beim Löschen.", "error");
  } finally {
    executeMultiDeleteBtn.disabled = false;
    executeMultiDeleteBtn.textContent = "Löschen";
  }
}

toggleMultiDeleteBtn.addEventListener("click", () => {
  toggleMultiDeleteMode();
});

cancelMultiDeleteBtn.addEventListener("click", () => {
  if (!isMultiDeleteMode) {
    return;
  }
  toggleMultiDeleteMode();
});

executeMultiDeleteBtn.addEventListener("click", () => {
  void executeMultiDelete();
});

selectAllCheckbox.addEventListener("change", (event) => {
  const checked = event.target.checked;
  const visibleFiles = filterFiles(allFiles);
  const checkboxes = filesTableBody.querySelectorAll(".file-checkbox");

  if (checked) {
    for (const file of visibleFiles) {
      selectedFileIds.add(file.id);
    }
  } else {
    for (const file of visibleFiles) {
      selectedFileIds.delete(file.id);
    }
  }

  checkboxes.forEach((cb) => {
    cb.checked = checked;
  });

  const rows = filesTableBody.querySelectorAll("tr[data-file-id]");
  rows.forEach((row) => {
    row.classList.toggle("is-selected", checked);
  });

  updateMultiDeleteCount();
});

filesTableBody.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.classList.contains("file-checkbox")) {
    return;
  }

  const fileId = target.dataset.fileId;
  if (!fileId) {
    return;
  }

  if (target.checked) {
    selectedFileIds.add(fileId);
  } else {
    selectedFileIds.delete(fileId);
  }

  const row = target.closest("tr[data-file-id]");
  if (row instanceof HTMLElement) {
    row.classList.toggle("is-selected", target.checked);
  }

  const visibleFiles = filterFiles(allFiles);
  const allVisibleSelected = visibleFiles.length > 0 && visibleFiles.every((file) => selectedFileIds.has(file.id));
  selectAllCheckbox.checked = allVisibleSelected;

  updateMultiDeleteCount();
});

window.addEventListener("beforeunload", () => {
  if (pendingDelete) {
    clearTimeout(pendingDelete.timerId);
  }
  closePreviewModal();
  revokeAllPreviewUrls();
  analysisCache.clear();
  analysisPromiseCache.clear();
});

copyrightYearEl.textContent = String(new Date().getFullYear());
void loadCaseContext().then(() => {
  loadFiles();
});

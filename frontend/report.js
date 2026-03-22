const token = sessionStorage.getItem("token");
const urlParams = new URLSearchParams(window.location.search);
const queryCaseId = String(urlParams.get("caseId") || "").trim();
const currentCaseId = queryCaseId || String(sessionStorage.getItem("currentCaseId") || "").trim();
const autoPrint = ["1", "true", "yes"].includes(String(urlParams.get("autoprint") || "").toLowerCase());
const reportSheet = document.getElementById("reportSheet");
const backBtn = document.getElementById("backBtn");
const printBtn = document.getElementById("printBtn");

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

if (!token) {
  window.location.replace("/");
}

if (!/^\d{6}$/.test(currentCaseId)) {
  window.location.replace("/dashboard.html");
}

function normalizeTitleText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return normalizeTitleText(value) || "Unbekannt";
  }
  const dateStr = date.toLocaleDateString("de-CH", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const timeStr = date.toLocaleTimeString("de-CH", {
    hour: "2-digit",
    minute: "2-digit"
  });
  return `${dateStr} ${timeStr}`;
}

function formatSwissAnalysisDate(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "Unbekannt";
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

function resolveFileType(file) {
  const mime = String(file?.mime_type || "").toLowerCase();
  const name = String(file?.original_name || "").toLowerCase();

  if (mime.includes("pdf") || name.endsWith(".pdf")) {
    return { className: "pdf", label: "PDF" };
  }
  if (mime.includes("png") || name.endsWith(".png")) {
    return { className: "png", label: "PNG" };
  }
  if (mime.includes("jpeg") || mime.includes("jpg") || name.endsWith(".jpg") || name.endsWith(".jpeg")) {
    return { className: "jpg", label: "JPG" };
  }
  return { className: "generic", label: "DATEI" };
}

function resolveDocumentTypeLabel(aiType, file) {
  const normalized = normalizeTitleText(aiType).toLowerCase();
  const map = {
    chat: "Chat",
    brief: "Brief",
    "e-mail": "E-Mail",
    email: "E-Mail",
    foto: "Foto",
    film: "Film",
    whatsapp: "Chat"
  };

  if (map[normalized]) {
    return map[normalized];
  }

  const mime = String(file?.mime_type || "").toLowerCase();
  if (mime.includes("pdf")) {
    return "Brief";
  }
  if (mime.startsWith("image/")) {
    return "Foto";
  }
  return normalizeTitleText(aiType) || resolveFileType(file).label;
}

function deriveQualityLabel(score) {
  if (!Number.isFinite(score)) {
    return "Nicht verfügbar";
  }
  if (score >= 0.94) {
    return "Hoch";
  }
  if (score >= 0.86) {
    return "Gut";
  }
  if (score >= 0.74) {
    return "Mittel";
  }
  return "Niedrig";
}

function normalizeTextQualityMeta(value) {
  const score = Number.isFinite(Number(value?.score)) ? Number(value.score) : null;
  return {
    score,
    label: normalizeTitleText(value?.label) || deriveQualityLabel(score),
    confidence: normalizeTitleText(value?.confidence) || (score === null ? "Manuell prüfen" : (score >= 0.8 ? "Gut" : "Mittel")),
    extractionMethod: normalizeTitleText(value?.extractionMethod) || "Unbekannt",
    sourceType: normalizeTitleText(value?.sourceType) || "",
    ocrUsed: Boolean(value?.ocrUsed)
  };
}

function normalizeEvidence(value) {
  const createSection = () => ({ positive: [], negative: [] });
  const safe = {
    protectedPerson: createSection(),
    opposingParty: createSection()
  };
  const src = value && typeof value === "object" ? value : {};

  for (const side of ["protectedPerson", "opposingParty"]) {
    const sourceSection = src[side] && typeof src[side] === "object" ? src[side] : {};
    for (const tone of ["positive", "negative"]) {
      safe[side][tone] = (Array.isArray(sourceSection[tone]) ? sourceSection[tone] : [])
        .map((item) => normalizeTitleText(item))
        .filter(Boolean)
        .slice(0, 4);
    }
  }

  return safe;
}

function countEvidenceSnippets(evidence) {
  const safe = normalizeEvidence(evidence);
  return safe.protectedPerson.positive.length
    + safe.protectedPerson.negative.length
    + safe.opposingParty.positive.length
    + safe.opposingParty.negative.length;
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
    .slice(0, 16);
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

function deriveDocumentVerdict(analysis) {
  const protectedPositive = Math.max(0, Number(analysis?.positiveMentions || 0));
  const protectedNegative = Math.max(0, Number(analysis?.negativeMentions || 0));
  const opposingPositive = Math.max(0, Number(analysis?.opposingPositiveMentions || 0));
  const opposingNegative = Math.max(0, Number(analysis?.opposingNegativeMentions || 0));
  const pressure = (protectedNegative + opposingPositive) - (protectedPositive + opposingNegative);

  if (pressure >= 4) {
    return { label: "Deutlich belastend", tone: "negative", detail: `Saldo ${pressure}` };
  }
  if (pressure >= 1) {
    return { label: "Leicht belastend", tone: "negative", detail: `Saldo ${pressure}` };
  }
  if (pressure <= -4) {
    return { label: "Deutlich entlastend", tone: "positive", detail: `Saldo ${pressure}` };
  }
  if (pressure <= -1) {
    return { label: "Leicht entlastend", tone: "positive", detail: `Saldo ${pressure}` };
  }
  return { label: "Eher ausgewogen", tone: "neutral", detail: "Saldo 0" };
}

function deriveDossierVerdict(totalPositive, totalNegative, analyzedCount) {
  if (analyzedCount <= 0) {
    return {
      label: "Noch keine belastbare Einordnung",
      tone: "neutral",
      detail: "Es liegen noch keine auswertbaren Dokumentanalysen vor."
    };
  }

  const pressure = totalNegative - totalPositive;
  if (pressure >= 6) {
    return { label: "Belastungstendenz erkennbar", tone: "negative", detail: `Negativsaldo ${pressure}` };
  }
  if (pressure >= 2) {
    return { label: "Leichte Belastungstendenz", tone: "negative", detail: `Negativsaldo ${pressure}` };
  }
  if (pressure <= -6) {
    return { label: "Entlastungstendenz erkennbar", tone: "positive", detail: `Positivsaldo ${Math.abs(pressure)}` };
  }
  if (pressure <= -2) {
    return { label: "Leichte Entlastungstendenz", tone: "positive", detail: `Positivsaldo ${Math.abs(pressure)}` };
  }
  return { label: "Gemischtes oder ausgeglichenes Bild", tone: "neutral", detail: "Kein deutlicher Gesamtsaldo" };
}

function derivePartySummaryTone(positiveCount, negativeCount) {
  const positive = Math.max(0, Number(positiveCount || 0));
  const negative = Math.max(0, Number(negativeCount || 0));
  if (negative > positive) {
    return "negative";
  }
  if (positive > negative) {
    return "positive";
  }
  return "neutral";
}

function formatPartySummaryValue(positiveCount, negativeCount) {
  return `Pos ${Math.max(0, Number(positiveCount || 0))} · Neg ${Math.max(0, Number(negativeCount || 0))}`;
}

function buildLoginRedirectMessage(detail) {
  const normalized = String(detail || "").trim().toLowerCase();
  if (normalized.includes("nicht autorisiert")) {
    return "Bitte erneut anmelden.";
  }
  return "Sitzung abgelaufen. Bitte erneut anmelden.";
}

function redirectToLogin(detail) {
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

async function getCaseContext() {
  const response = await apiFetch(`${API_BASE}/cases`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error("Falldaten konnten nicht geladen werden.");
  }

  const payload = await response.json().catch(() => ({}));
  const cases = Array.isArray(payload?.cases) ? payload.cases : [];
  const active = cases.find((entry) => String(entry?.id || "") === currentCaseId);
  if (!active) {
    throw new Error("Fall nicht gefunden.");
  }

  return {
    id: currentCaseId,
    caseName: normalizeTitleText(active.case_name || ""),
    protectedPerson: normalizeTitleText(active.protected_person_name || ""),
    opposingParty: normalizeTitleText(active.opposing_party || ""),
    protectedKeywords: String(active.protected_person_name || "").trim(),
    opposingKeywords: String(active.opposing_party || "").trim(),
    country: normalizeTitleText(active.country || ""),
    locality: normalizeTitleText(active.locality || ""),
    region: normalizeTitleText(active.region || active.locality || ""),
    city: normalizeTitleText(active.city || "")
  };
}

async function getFiles() {
  const response = await apiFetch(`${API_BASE}/cases/${currentCaseId}/files`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    throw new Error("Dateien konnten nicht geladen werden.");
  }

  const payload = await response.json().catch(() => ({}));
  return Array.isArray(payload?.files) ? payload.files : [];
}

async function getDocumentAnalysis(file) {
  const response = await apiFetch(`${API_BASE}/cases/${currentCaseId}/files/${file.id}/analysis?onlyStored=1`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (!response.ok) {
    return { status: "error", message: "Analyse konnte nicht geladen werden." };
  }

  const payload = await response.json().catch(() => ({}));
  return {
    status: payload.status || "ok",
    documentType: normalizeTitleText(payload.documentType),
    title: normalizeTitleText(payload.title),
    author: normalizeTitleText(payload.author),
    authoredDate: normalizeTitleText(payload.authoredDate),
    people: normalizePeople(payload.people),
    disadvantagedPerson: normalizeTitleText(payload.disadvantagedPerson),
    senderInstitution: normalizeTitleText(payload.senderInstitution),
    impactAssessment: normalizeTitleText(payload.impactAssessment),
    impactRanking: normalizeImpactRanking(payload.impactRanking),
    positiveMentions: Number.isFinite(Number(payload.positiveMentions)) ? Number(payload.positiveMentions) : 0,
    negativeMentions: Number.isFinite(Number(payload.negativeMentions)) ? Number(payload.negativeMentions) : 0,
    opposingPositiveMentions: Number.isFinite(Number(payload.opposingPositiveMentions)) ? Number(payload.opposingPositiveMentions) : 0,
    opposingNegativeMentions: Number.isFinite(Number(payload.opposingNegativeMentions)) ? Number(payload.opposingNegativeMentions) : 0,
    message: normalizeTitleText(payload.message),
    analysisEngineVersion: normalizeTitleText(payload.analysisEngineVersion),
    backendStartedAt: normalizeTitleText(payload.backendStartedAt),
    methodology: normalizeTitleText(payload.methodology),
    evidence: normalizeEvidence(payload.evidence),
    textQuality: normalizeTextQualityMeta(payload.textQuality)
  };
}

function renderEvidenceList(items, emptyText) {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (safeItems.length === 0) {
    return `<p class="report-evidence-empty">${escapeHtml(emptyText)}</p>`;
  }

  return `<ul class="report-evidence-list">${safeItems.map((item) => `<li>„${escapeHtml(item)}“</li>`).join("")}</ul>`;
}

function renderSummaryCard(label, value, detail, tone = "neutral") {
  return `<article class="report-summary-card is-${tone}"><span class="report-summary-label">${escapeHtml(label)}</span><strong class="report-summary-value">${escapeHtml(value)}</strong><span class="report-summary-detail">${escapeHtml(detail)}</span></article>`;
}

function renderDocumentCard(entry, index, context) {
  const file = entry.file;
  const analysis = entry.analysis;
  const verdict = deriveDocumentVerdict(analysis);
  const textQuality = normalizeTextQualityMeta(analysis.textQuality);
  const evidence = normalizeEvidence(analysis.evidence);
  const evidenceCount = countEvidenceSnippets(evidence);
  const qualityValue = Number.isFinite(textQuality.score)
    ? `${textQuality.label} · ${textQuality.score.toFixed(2)}`
    : textQuality.label;
  const qualityTone = textQuality.label === "Hoch" || textQuality.label === "Gut"
    ? "positive"
    : (textQuality.label === "Niedrig" ? "negative" : "neutral");
  const engineText = analysis.analysisEngineVersion || analysis.backendStartedAt
    ? `${analysis.analysisEngineVersion || "unbekannt"}${analysis.backendStartedAt ? ` · Instanz ${analysis.backendStartedAt}` : ""}`
    : "Nicht ausgewiesen";
  const people = Array.isArray(analysis.people) ? analysis.people.map((item) => item.name).filter(Boolean).join(" · ") : "Keine";
  const focusItems = Array.isArray(analysis.impactRanking) ? analysis.impactRanking.slice(0, 4) : [];
  const docType = resolveDocumentTypeLabel(analysis.documentType, file);

  if (analysis.status !== "ok") {
    return `
      <article class="report-document">
        <div class="report-document-head">
          <span class="report-document-index">${index}</span>
          <div class="report-document-title-group">
            <h3 class="report-document-title">${escapeHtml(file.original_name || `Dokument ${index}`)}</h3>
            <div class="report-document-meta">${escapeHtml(formatDate(file.uploaded_at))} · ${escapeHtml(resolveFileType(file).label)}</div>
          </div>
          <div class="report-chip-row">
            <span class="report-chip is-neutral">Analyse offen</span>
          </div>
        </div>
        <div class="report-doc-empty-box">
          <span class="report-subgrid-title">Status</span>
          <p class="report-document-status">${escapeHtml(analysis.message || "Für dieses Dokument liegt noch keine gespeicherte Analyse vor.")}</p>
        </div>
      </article>
    `;
  }

  return `
    <article class="report-document">
      <div class="report-document-head">
        <span class="report-document-index">${index}</span>
        <div class="report-document-title-group">
          <h3 class="report-document-title">${escapeHtml(analysis.title || file.original_name || `Dokument ${index}`)}</h3>
          <div class="report-document-meta">${escapeHtml(file.original_name || "")}</div>
          <div class="report-document-meta">${escapeHtml(formatDate(file.uploaded_at))} · ${escapeHtml(docType)}</div>
        </div>
        <div class="report-chip-row">
          <span class="report-chip is-${escapeHtml(verdict.tone)}">${escapeHtml(verdict.label)}</span>
          <span class="report-chip is-${escapeHtml(qualityTone)}">${escapeHtml(qualityValue)}</span>
          <span class="report-chip is-neutral">Belegstellen ${escapeHtml(String(evidenceCount))}</span>
        </div>
      </div>

      <div class="report-doc-grid">
        <div class="report-doc-meta-box">
          <span class="report-subgrid-title">Dokumentdaten</span>
          <div class="report-facts">
            <div class="report-fact"><span class="report-fact-label">Verfasser</span><span class="report-fact-value">${escapeHtml(analysis.author || "Unbekannt")}</span></div>
            <div class="report-fact"><span class="report-fact-label">Datum</span><span class="report-fact-value">${escapeHtml(formatSwissAnalysisDate(analysis.authoredDate))}</span></div>
            <div class="report-fact"><span class="report-fact-label">Herkunft</span><span class="report-fact-value">${escapeHtml(analysis.senderInstitution || "Unbekannt")}</span></div>
            <div class="report-fact"><span class="report-fact-label">Personen</span><span class="report-fact-value">${escapeHtml(people)}</span></div>
            <div class="report-fact"><span class="report-fact-label">Extraktion</span><span class="report-fact-value">${escapeHtml(textQuality.extractionMethod)}</span></div>
            <div class="report-fact"><span class="report-fact-label">Engine</span><span class="report-fact-value">${escapeHtml(engineText)}</span></div>
            <div class="report-fact"><span class="report-fact-label">Fazit</span><span class="report-fact-value">${escapeHtml(analysis.impactAssessment || "Keine Kurzbeurteilung gespeichert")}</span></div>
          </div>
        </div>

        <div class="report-doc-party-box">
          <span class="report-subgrid-title">Parteibilanz</span>
          <div class="report-party-grid">
            <article class="report-party-card">
              <div class="report-party-title">
                <strong>${escapeHtml(context.protectedLabel)}</strong>
                <span>${escapeHtml(context.protectedKeywords || "Nicht gesetzt")}</span>
              </div>
              <div class="report-party-score-row"><span>Positiv</span><em class="is-positive">${escapeHtml(String(Math.max(0, Number(analysis.positiveMentions || 0))))}</em></div>
              <div class="report-party-score-row"><span>Negativ</span><em class="is-negative">${escapeHtml(String(Math.max(0, Number(analysis.negativeMentions || 0))))}</em></div>
            </article>
            <article class="report-party-card">
              <div class="report-party-title">
                <strong>${escapeHtml(context.opposingLabel)}</strong>
                <span>${escapeHtml(context.opposingKeywords || "Nicht gesetzt")}</span>
              </div>
              <div class="report-party-score-row"><span>Positiv</span><em class="is-positive">${escapeHtml(String(Math.max(0, Number(analysis.opposingPositiveMentions || 0))))}</em></div>
              <div class="report-party-score-row"><span>Negativ</span><em class="is-negative">${escapeHtml(String(Math.max(0, Number(analysis.opposingNegativeMentions || 0))))}</em></div>
            </article>
          </div>
        </div>
      </div>

      <div class="report-evidence-grid">
        <article class="report-evidence-card is-positive">
          <strong>${escapeHtml(context.protectedLabel)} · Positiv</strong>
          ${renderEvidenceList(evidence.protectedPerson.positive, "Keine positiven Belegstellen gespeichert.")}
        </article>
        <article class="report-evidence-card is-negative">
          <strong>${escapeHtml(context.protectedLabel)} · Negativ</strong>
          ${renderEvidenceList(evidence.protectedPerson.negative, "Keine negativen Belegstellen gespeichert.")}
        </article>
        <article class="report-evidence-card is-positive">
          <strong>${escapeHtml(context.opposingLabel)} · Positiv</strong>
          ${renderEvidenceList(evidence.opposingParty.positive, "Keine positiven Belegstellen gespeichert.")}
        </article>
        <article class="report-evidence-card is-negative">
          <strong>${escapeHtml(context.opposingLabel)} · Negativ</strong>
          ${renderEvidenceList(evidence.opposingParty.negative, "Keine negativen Belegstellen gespeichert.")}
        </article>
      </div>

      <div class="report-doc-grid">
        <div class="report-doc-focus-box">
          <span class="report-subgrid-title">Methodik</span>
          <p class="report-document-note">${escapeHtml(analysis.methodology || "Parteibezogene Positiv-/Negativzählung mit Belegstellenprüfung.")}</p>
          <p class="report-document-note">Textqualität: ${escapeHtml(qualityValue)} · Vertrauen ${escapeHtml(textQuality.confidence)}</p>
          <p class="report-document-note">Dokumenturteil: ${escapeHtml(verdict.label)} · ${escapeHtml(verdict.detail)}</p>
        </div>
        <div class="report-doc-focus-box">
          <span class="report-subgrid-title">Beteiligte im Fokus</span>
          ${focusItems.length === 0 ? `<p class="report-evidence-empty">Keine gewichteten Personenhinweise gespeichert.</p>` : `<ul class="report-focus-list">${focusItems.map((item) => `<li class="report-focus-item"><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.items?.[0] || item.impact || "Neutral")}</span><em>Anzahl ${escapeHtml(String(Number(item.count || 0)))}</em></li>`).join("")}</ul>`}
        </div>
      </div>
    </article>
  `;
}

function renderReport(caseContext, entries) {
  const analyzedEntries = entries.filter((entry) => entry.analysis.status === "ok");
  const protectedPositiveTotal = analyzedEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.analysis.positiveMentions || 0)), 0);
  const protectedNegativeTotal = analyzedEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.analysis.negativeMentions || 0)), 0);
  const opposingPositiveTotal = analyzedEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.analysis.opposingPositiveMentions || 0)), 0);
  const opposingNegativeTotal = analyzedEntries.reduce((sum, entry) => sum + Math.max(0, Number(entry.analysis.opposingNegativeMentions || 0)), 0);
  const totalPositive = protectedPositiveTotal + opposingPositiveTotal;
  const totalNegative = protectedNegativeTotal + opposingNegativeTotal;
  const evidenceCount = analyzedEntries.reduce((sum, entry) => sum + countEvidenceSnippets(entry.analysis.evidence), 0);
  const ocrCount = analyzedEntries.reduce((sum, entry) => sum + (entry.analysis.textQuality?.ocrUsed ? 1 : 0), 0);
  const qualityScores = analyzedEntries
    .map((entry) => Number(entry.analysis.textQuality?.score))
    .filter((score) => Number.isFinite(score));
  const avgQuality = qualityScores.length > 0 ? qualityScores.reduce((sum, score) => sum + score, 0) / qualityScores.length : null;
  const verdict = deriveDossierVerdict(totalPositive, totalNegative, analyzedEntries.length);
  const methodology = analyzedEntries.find((entry) => entry.analysis.methodology)?.analysis.methodology
    || "Parteibezogene Positiv-/Negativzählung mit Belegstellen und Qualitätsprüfung.";

  document.title = `DMSKI Report ${caseContext.caseName || currentCaseId}`;

  reportSheet.innerHTML = `
    <header class="report-header">
      <img src="assets/logo-dmski_slogan.png" alt="DMSKI" class="report-logo" />
      <div class="report-title-block">
        <p class="report-eyebrow">Forensische Dossierauswertung</p>
        <h1 class="report-title">${escapeHtml(caseContext.caseName || `Fall ${currentCaseId}`)}</h1>
        <p class="report-subtitle">Dossier-ID ${escapeHtml(currentCaseId)} · Druckansicht für PDF-Ablage</p>
      </div>
      <aside class="report-stamp">
        <span class="report-stamp-label">Erstellt am</span>
        <span class="report-stamp-value">${escapeHtml(formatDate(new Date().toISOString()))}</span>
        <span class="report-stamp-label">Status</span>
        <span class="report-stamp-value">${escapeHtml(verdict.label)}</span>
      </aside>
    </header>

    <section class="report-grid">
      <section class="report-section">
        <div class="report-section-head">
          <h2 class="report-section-title">Dossierübersicht</h2>
          <p class="report-section-note">Zusammenfassung über alle gespeicherten Dokumentanalysen</p>
        </div>
        <div class="report-summary-grid">
          ${renderSummaryCard("Dateien im Dossier", String(entries.length), analyzedEntries.length === entries.length ? "Vollständig erfasst" : `${analyzedEntries.length} analysiert`, "neutral")}
          ${renderSummaryCard("Benachteiligte Person", formatPartySummaryValue(protectedPositiveTotal, protectedNegativeTotal), caseContext.protectedPerson || "Nicht gesetzt", derivePartySummaryTone(protectedPositiveTotal, protectedNegativeTotal))}
          ${renderSummaryCard("Gegenpartei", formatPartySummaryValue(opposingPositiveTotal, opposingNegativeTotal), caseContext.opposingParty || "Nicht gesetzt", derivePartySummaryTone(opposingPositiveTotal, opposingNegativeTotal))}
          ${renderSummaryCard("Gesamtbilanz", totalPositive === totalNegative ? "Neutral" : `${totalPositive - totalNegative > 0 ? "+" : ""}${totalPositive - totalNegative}`, ocrCount > 0 ? `${ocrCount} OCR-Fallback · ${evidenceCount} Belegstellen` : `${evidenceCount} Belegstellen`, totalPositive === totalNegative ? "neutral" : (totalPositive > totalNegative ? "positive" : "negative"))}
        </div>
      </section>

      <section class="report-section">
        <div class="report-section-head">
          <h2 class="report-section-title">Fallkontext</h2>
          <p class="report-section-note">Parteien- und Ortsdaten für die juristische Einordnung</p>
        </div>
        <div class="report-meta-grid">
          <article class="report-meta-card">
            <strong>Benachteiligte Person</strong>
            <span>${escapeHtml(caseContext.protectedPerson || "Nicht gesetzt")}</span>
          </article>
          <article class="report-meta-card">
            <strong>Gegenpartei</strong>
            <span>${escapeHtml(caseContext.opposingParty || "Nicht gesetzt")}</span>
          </article>
          <article class="report-meta-card">
            <strong>Ortschaft / Sitz des Gerichts</strong>
            <span>${escapeHtml(caseContext.city || "Nicht gesetzt")}</span>
          </article>
          <article class="report-meta-card">
            <strong>Land</strong>
            <span>${escapeHtml(caseContext.country || "Nicht gesetzt")}</span>
          </article>
          <article class="report-meta-card">
            <strong>Region / Kanton</strong>
            <span>${escapeHtml(caseContext.region || "Nicht gesetzt")}</span>
          </article>
          <article class="report-meta-card">
            <strong>Belegstellen</strong>
            <span>${escapeHtml(String(evidenceCount))} dossierweit verdichtet</span>
          </article>
        </div>
      </section>

      <section class="report-section">
        <div class="report-section-head">
          <h2 class="report-section-title">Methodik und Einordnung</h2>
          <p class="report-section-note">Die nachfolgenden Punkte dienen der schnellen Plausibilisierung im Aktenkontext</p>
        </div>
        <div class="report-method-grid">
          <article class="report-method-card">
            <strong>Methodik</strong>
            <p>${escapeHtml(methodology)}</p>
          </article>
          <article class="report-method-card">
            <strong>Gesamturteil</strong>
            <p>${escapeHtml(verdict.label)} · ${escapeHtml(verdict.detail)}</p>
            <p>Der Report ist als strukturierte Vorprüfung gedacht und ersetzt keine juristische Gesamtwürdigung.</p>
          </article>
        </div>
      </section>

      <section class="report-section">
        <div class="report-section-head">
          <h2 class="report-section-title">Dokumentberichte</h2>
          <p class="report-section-note">Jedes Dokument mit Kurzurteil, Parteibilanz und Belegstellen</p>
        </div>
        <div class="report-document-list">
          ${entries.map((entry, index) => renderDocumentCard(entry, index + 1, {
            protectedLabel: "Benachteiligte Person",
            opposingLabel: "Gegenpartei",
            protectedKeywords: caseContext.protectedKeywords,
            opposingKeywords: caseContext.opposingKeywords
          })).join("")}
        </div>
      </section>
    </section>

    <footer class="report-footer">
      <div class="report-footer-brand">
        <img src="assets/logo-dmski.png" alt="DMSKI" />
        <span>DMSKI · Forensischer PDF-Report für Fall ${escapeHtml(currentCaseId)}</span>
      </div>
      <span>Prompted by AiKMU // GetLeedz GmbH</span>
    </footer>
  `;
}

function renderError(message) {
  reportSheet.innerHTML = `
    <section class="report-error">
      <img src="assets/logo-dmski.png" alt="DMSKI" class="report-loading-logo" />
      <h1>Report konnte nicht erstellt werden</h1>
      <p>${escapeHtml(message)}</p>
    </section>
  `;
}

async function initReport() {
  try {
    const caseContext = await getCaseContext();
    const files = await getFiles();
    const entries = await Promise.all(files.map(async (file) => ({
      file,
      analysis: await getDocumentAnalysis(file)
    })));

    renderReport(caseContext, entries);

    if (autoPrint) {
      window.setTimeout(() => {
        window.print();
      }, 450);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
    renderError(error instanceof Error ? error.message : "Unbekannter Fehler beim Erstellen des Reports.");
  }
}

backBtn?.addEventListener("click", () => {
  if (window.history.length > 1) {
    window.history.back();
    return;
  }
  window.location.href = "/files.html";
});

printBtn?.addEventListener("click", () => {
  window.print();
});

void initReport();

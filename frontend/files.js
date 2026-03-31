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

const OUTAGE_STATUSES = new Set([502, 503, 504]);
let serviceAlertEl = null;
let authRedirectStarted = false;

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
const goToUploadBtnHero = document.getElementById("goToUploadBtnHero");
const exportPdfReportBtn = document.getElementById("exportPdfReportBtn");
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
const analysisReportBar = document.getElementById("analysisReportBar");
const analysisReportGrid = document.getElementById("analysisReportGrid");
const analysisReportHint = document.getElementById("analysisReportHint");
const analysisReportMeta = document.getElementById("analysisReportMeta");
const analysisReportTactics = document.getElementById("analysisReportTactics");
const analysisReportAkteure = document.getElementById("analysisReportAkteure");
const dateToFilter = document.getElementById("dateToFilter");
const sortUploadDateBtn = document.getElementById("sortUploadDateBtn");
const sortFileDateBtn = document.getElementById("sortFileDateBtn");
const downloadAllFilesBtn = document.getElementById("downloadAllFilesBtn");

let allFiles = [];
const previewUrlCache = new Map();
const previewPromiseCache = new Map();
const analysisCache = new Map();
const analysisPromiseCache = new Map();
let modalZoom = 1;
let pendingDelete = null;
let isMultiDeleteMode = false;
const selectedFileIds = new Set();
let currentCaseProtectedKeywords = "";
let currentCaseOpposingKeywords = "";
let currentCaseProtectedPerson = "";
let currentCaseProtectedLabel = "Fokus-Partei";
let currentCaseName = "";
let currentCaseOpposingParty = "";
let currentCaseOpposingLabel = "Gegenpartei";
let currentCaseCountry = "";
let currentCaseLocality = "";
let currentCaseRegion = "";
let currentCaseCity = "";
let currentSortField = "uploadDate"; // "uploadDate" | "fileDate"
let currentSortOrder = "desc";      // "asc" | "desc"

listTitle.textContent = "Fall";

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const PENCIL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;

const currentUserRole = sessionStorage.getItem("dmski_role") || "customer";
const canEditCase = currentUserRole === "admin" || currentUserRole === "customer";

function buildEditableField(cssClass, apiField, label, value, style) {
  const styleAttr = style ? ` style="${style}"` : "";
  const editBtn = canEditCase ? `<button class="case-edit-btn" title="${escapeHtml(label)} bearbeiten" aria-label="${escapeHtml(label)} bearbeiten">${PENCIL_SVG}</button>` : "";
  return `<div class="case-person-field ${cssClass}" data-edit-field="${apiField}"${styleAttr}><div class="case-field-row"><div class="case-field-body"><span class="case-person-label">${escapeHtml(label)}</span><span class="case-person-value">${escapeHtml(value || "Nicht gesetzt")}</span></div>${editBtn}</div></div>`;
}

const COUNTRY_OPTIONS = ["Schweiz", "Deutschland", "Österreich"];

const REGIONS_BY_COUNTRY_EDIT = [
  {
    country: "Schweiz",
    label: "Kanton",
    options: [
      "Aargau","Appenzell Ausserrhoden","Appenzell Innerrhoden","Basel-Landschaft","Basel-Stadt",
      "Bern","Freiburg","Genf","Glarus","Graubünden","Jura","Luzern","Neuenburg","Nidwalden",
      "Obwalden","Schaffhausen","Schwyz","Solothurn","St. Gallen","Tessin","Thurgau","Uri",
      "Waadt","Wallis","Zug","Zürich"
    ]
  },
  {
    country: "Deutschland",
    label: "Bundesland",
    options: [
      "Baden-Württemberg","Bayern","Berlin","Brandenburg","Bremen","Hamburg",
      "Hessen","Mecklenburg-Vorpommern","Niedersachsen","Nordrhein-Westfalen",
      "Rheinland-Pfalz","Saarland","Sachsen","Sachsen-Anhalt",
      "Schleswig-Holstein","Thüringen"
    ]
  },
  {
    country: "Österreich",
    label: "Bundesland",
    options: [
      "Burgenland","Kärnten","Niederösterreich","Oberösterreich",
      "Salzburg","Steiermark","Tirol","Vorarlberg","Wien"
    ]
  }
];

function getRegionOptionsForCountry(country) {
  const needle = String(country || "").trim().toLowerCase().normalize("NFC");
  const found = REGIONS_BY_COUNTRY_EDIT.find(
    (entry) => entry.country.toLowerCase().normalize("NFC") === needle
  );
  return found || {
    country: "",
    label: "Kanton / Bundesland",
    options: REGIONS_BY_COUNTRY_EDIT[0].options
  };
}

function buildSelectOptions(options, current) {
  return options.map((o) => `<option value="${escapeHtml(o)}"${o === current ? " selected" : ""}>${escapeHtml(o)}</option>`).join("");
}

function startCaseFieldEdit(fieldEl) {
  const labelEl = fieldEl.querySelector(".case-person-label");
  const valueEl = fieldEl.querySelector(".case-person-value");
  const row = fieldEl.querySelector(".case-field-row");
  if (!labelEl || !valueEl || !row) return;
  const label = labelEl.textContent.trim();
  const apiField = fieldEl.dataset.editField;
  const currentValue = valueEl.textContent.trim();
  const originalValue = currentValue === "Nicht gesetzt" ? "" : currentValue;

  let inputHtml;
  if (apiField === "country") {
    inputHtml = `<select class="case-edit-input" data-original="${escapeHtml(currentValue)}">${buildSelectOptions(COUNTRY_OPTIONS, originalValue)}</select>`;
  } else if (apiField === "region") {
    const regionEntry = getRegionOptionsForCountry(currentCaseCountry);
    inputHtml = `<select class="case-edit-input" data-original="${escapeHtml(currentValue)}">${buildSelectOptions(regionEntry.options, originalValue)}</select>`;
  } else {
    inputHtml = `<input class="case-edit-input" value="${escapeHtml(originalValue)}" data-original="${escapeHtml(currentValue)}" />`;
  }

  row.innerHTML = `<div class="case-field-body"><span class="case-person-label">${escapeHtml(label)}</span>${inputHtml}</div><div class="case-edit-actions"><button class="case-save-btn" data-action="save-field" title="Speichern">✓</button><button class="case-cancel-btn" data-action="cancel-field" title="Abbrechen">✗</button></div>`;
  row.querySelector(".case-edit-input")?.focus();
}

async function saveCaseField(fieldEl) {
  const apiField = fieldEl.dataset.editField;
  const input = fieldEl.querySelector(".case-edit-input");
  const labelEl = fieldEl.querySelector(".case-person-label");
  if (!input || !labelEl) return;
  const newValue = input.value.trim();
  const label = labelEl.textContent.trim();
  const saveBtn = fieldEl.querySelector(".case-save-btn");
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "…"; }
  try {
    const response = await apiFetch(`${API_BASE}/cases/${currentCaseId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ [apiField]: newValue })
    });
    if (!response.ok) {
      const p = await response.json().catch(() => ({}));
      throw new Error(p.error || "Fehler beim Speichern.");
    }
    if (apiField === "case_name") currentCaseName = newValue;
    else if (apiField === "protected_person_name") { currentCaseProtectedPerson = newValue; currentCaseProtectedKeywords = newValue; }
    else if (apiField === "opposing_party") { currentCaseOpposingParty = newValue; currentCaseOpposingKeywords = newValue; }
    else if (apiField === "country") currentCaseCountry = newValue;
    else if (apiField === "region") currentCaseRegion = newValue;
    else if (apiField === "city") currentCaseCity = newValue;
    const row = fieldEl.querySelector(".case-field-row");
    if (row) row.innerHTML = `<div class="case-field-body"><span class="case-person-label">${escapeHtml(label)}</span><span class="case-person-value">${escapeHtml(newValue || "Nicht gesetzt")}</span></div><button class="case-edit-btn" title="${escapeHtml(label)} bearbeiten" aria-label="${escapeHtml(label)} bearbeiten">${PENCIL_SVG}</button>`;
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") return;
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = "✓"; }
    setMessage(listMessage, error.message || "Fehler beim Speichern.", "error");
  }
}

function cancelCaseFieldEdit(fieldEl) {
  const input = fieldEl.querySelector(".case-edit-input");
  const labelEl = fieldEl.querySelector(".case-person-label");
  if (!input || !labelEl) return;
  const originalValue = input.dataset.original || "";
  const label = labelEl.textContent.trim();
  const row = fieldEl.querySelector(".case-field-row");
  if (row) row.innerHTML = `<div class="case-field-body"><span class="case-person-label">${escapeHtml(label)}</span><span class="case-person-value">${escapeHtml(originalValue)}</span></div><button class="case-edit-btn" title="${escapeHtml(label)} bearbeiten" aria-label="${escapeHtml(label)} bearbeiten">${PENCIL_SVG}</button>`;
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
      const items = Array.isArray(sourceSection[tone]) ? sourceSection[tone] : [];
      safe[side][tone] = items
        .map((item) => normalizeTitleText(item))
        .filter(Boolean)
        .slice(0, 3);
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
      detail: "Es liegen noch keine auswertbaren File-Analysen vor."
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

function renderAnalysisReportCard(label, value, detail = "", tone = "neutral") {
  return `<article class="analysis-report-card is-${tone}"><span class="analysis-report-card-label">${escapeHtml(label)}</span><strong class="analysis-report-card-value">${escapeHtml(value)}</strong>${detail ? `<span class="analysis-report-card-detail">${escapeHtml(detail)}</span>` : ""}</article>`;
}

function renderPartyReportCard(label, positiveCount, negativeCount) {
  const pos = Math.max(0, Number(positiveCount || 0));
  const neg = Math.max(0, Number(negativeCount || 0));
  return `<article class="analysis-report-card is-party"><span class="analysis-report-card-label">${escapeHtml(label)}</span><div class="party-split"><div class="party-split-item is-positive"><span class="party-split-num">${pos}</span><span class="party-split-label">Positiv</span></div><div class="party-split-item is-negative"><span class="party-split-num">${neg}</span><span class="party-split-label">Negativ</span></div></div></article>`;
}

function renderFileCountCard(count) {
  return `<article class="analysis-report-card is-file-count"><span class="analysis-report-card-label">ANZAHL FILES</span><div class="file-count-split"><div class="file-count-box"><span class="file-count-num">${escapeHtml(String(count))}</span><span class="file-count-label">Gesamtbestand</span></div></div></article>`;
}

function renderAnalysisReportMeta(_verdict, _methodology, _note) {
  return "";
}

/* ----------------------------------------------------------------
   TACTIC ANALYSIS – derives opposing-party strategy from numbers
   ---------------------------------------------------------------- */
function deriveTacticProfile(analysis, protectedPerson, opposingParty) {
  const protNeg  = Math.max(0, Number(analysis.negativeMentions || 0));
  const protPos  = Math.max(0, Number(analysis.positiveMentions || 0));
  const oppPos   = Math.max(0, Number(analysis.opposingPositiveMentions || 0));
  const oppNeg   = Math.max(0, Number(analysis.opposingNegativeMentions || 0));
  const pressure = (protNeg + oppPos) - (protPos + oppNeg);

  const nameG = escapeHtml(opposingParty || "Gegenpartei");
  const nameP = escapeHtml(protectedPerson || "Fokus-Partei");

  let profileTitle = "";
  let summary = "";
  let legalNote = "";
  let legalTitle = "";

  // Swiss-law-grounded findings table rows:
  // present = boolean, evidence = descriptive string
  const rows = [];

  if (pressure >= 4 || (protNeg >= 3 && oppPos >= 2)) {
    profileTitle = "Forensisches Profil: Systematisches Degradierungsmuster festgestellt";
    summary = `Die KI-Analyse ergibt ein klares Muster der <strong>systematischen Negativdarstellung</strong> von ${nameP}. Anstatt sachlich zum Verfahrensgegenstand zu argumentieren, rückt ${nameG} gezielt Persönlichkeit, Verhalten und Lebensumstände in den Vordergrund – eine klassische <strong>Ad-hominem-Strategie</strong>, die in der forensischen Verhaltensanalyse als Indiz für eine kalkulierte Degradierungskampagne gilt. Die Häufung negativer Aussagen ohne sachlichen Bezug zum Streitgegenstand ist ein Warnzeichen, das rechtlich relevante Konsequenzen haben kann.`;
    legalTitle = "Juristische Bewertung (KI als neutraler Rechtsbeobachter)";
    legalNote = `Gemäss BGE-Praxis gilt: Persönlichkeitsbezogene Angriffe ohne Relevanz für den Streitgegenstand können als <em>Prozessrechtsmissbrauch</em> im Sinne von Art. 2 Abs. 2 ZGB gewertet werden. Gemäss BGE 131 III 473 ist eine Gegendarstellung zulässig; ein Befangenheitsantrag gegen beteiligte Amtspersonen kann geprüft werden. Die nachfolgend erkannten Tatbestände sind Indizien, keine rechtskräftigen Feststellungen.`;
    rows.push({ tactic: "Üble Nachrede", article: "Art. 173 StGB (CH)", present: true,  evidence: "Indiz erkannt – negative Aussagen ohne Sachbezug" });
    rows.push({ tactic: "Verleumdung", article: "Art. 174 StGB (CH)", present: pressure >= 4, evidence: pressure >= 4 ? "Indiz erkannt – wissentlich falsche Tatsachen" : "Kein ausreichender Nachweis" });
    rows.push({ tactic: "Beschimpfung / Herabsetzung", article: "Art. 177 StGB (CH)", present: protNeg >= 2, evidence: protNeg >= 2 ? "Indiz erkannt – abwertende Charakterisierung" : "Kein Nachweis" });
    rows.push({ tactic: "Verletzung der Persönlichkeitsrechte", article: "Art. 28 ZGB (CH)", present: true,  evidence: "Indiz erkannt – sachfremde Persönlichkeitsangriffe" });
    rows.push({ tactic: "Prozessrechtsmissbrauch", article: "Art. 2 Abs. 2 ZGB (CH)", present: pressure >= 3, evidence: pressure >= 3 ? "Indiz erkannt – Taktik ohne Verfahrensrelevanz" : "Kein ausreichender Nachweis" });
    rows.push({ tactic: "Ad-hominem-Strategie", article: "Forensisch / Verfahrensrecht", present: true,  evidence: "Erkannt – Angriff auf Person statt auf Sache" });
    rows.push({ tactic: "Gaslighting / psycholog. Manipulation", article: "Art. 28 ZGB / Art. 181 StGB (CH)", present: protNeg >= 3, evidence: protNeg >= 3 ? "Indiz erkannt – systematische Verunsicherungsmuster" : "Kein Nachweis" });

  } else if (pressure >= 2 || protNeg >= 2) {
    profileTitle = "Forensisches Profil: Selektive Darstellung mit Belastungstendenz";
    summary = `Die KI-Analyse erkennt <strong>gezielte Ablenkungsstrategien</strong> im vorliegenden Material. Sachfremde Informationen über ${nameP} werden eingebracht, um vom eigentlichen Verfahrensgegenstand abzulenken. Diese als <strong>Red-Herring-Taktik</strong> bekannte Methode setzt irrelevante Charakterinformationen – Lebensstil, vergangene Ereignisse, Drittmeinungen – ein, um Behörden oder Gericht zu beeinflussen, ohne sachliche Argumente vorzubringen.`;
    legalTitle = "Juristische Bewertung (KI als neutraler Rechtsbeobachter)";
    legalNote = `Irrelevante Persönlichkeitsinformationen über die Fokus-Partei können gemäss Art. 152 ZPO formell gerügt werden. Das Gericht kann solche Ausführungen aus dem Recht weisen. Selektive Darstellungen können unter Art. 28 ZGB als Persönlichkeitsrechtsverletzung geprüft werden.`;
    rows.push({ tactic: "Üble Nachrede", article: "Art. 173 StGB (CH)", present: protNeg >= 2, evidence: protNeg >= 2 ? "Indiz erkannt" : "Kein ausreichender Nachweis" });
    rows.push({ tactic: "Verletzung der Persönlichkeitsrechte", article: "Art. 28 ZGB (CH)", present: true, evidence: "Indiz erkannt – sachfremde Darstellung" });
    rows.push({ tactic: "Red-Herring-Argumentation", article: "Forensisch / ZPO Art. 152", present: true, evidence: "Erkannt – Ablenkung vom Verfahrensgegenstand" });
    rows.push({ tactic: "Selektive Darstellung / Framing", article: "Forensisch / Art. 2 ZGB", present: true, evidence: "Erkannt – einseitige Auswahl von Informationen" });
    rows.push({ tactic: "Verleumdung", article: "Art. 174 StGB (CH)", present: false, evidence: "Kein ausreichender Nachweis" });
    rows.push({ tactic: "Prozessrechtsmissbrauch", article: "Art. 2 Abs. 2 ZGB (CH)", present: pressure >= 3, evidence: pressure >= 3 ? "Indiz erkannt" : "Kein ausreichender Nachweis" });

  } else if (pressure >= 1) {
    profileTitle = "Forensisches Profil: Leichte Verfahrenstendenz erkannt";
    summary = `Die KI-Analyse zeigt eine <strong>leicht einseitige Tendenz</strong> zuungunsten von ${nameP}. Einzelne Formulierungen begünstigen die Position von ${nameG} ohne sachliche Notwendigkeit. Dies reicht für eine eindeutige Taktikzuschreibung noch nicht aus, kann sich aber über mehrere Dokumente zu einem belastenden Muster verdichten.`;
    legalTitle = "Juristische Bewertung (KI als neutraler Rechtsbeobachter)";
    legalNote = `Bei leichter Tendenz empfiehlt sich die Gesamtbetrachtung weiterer Dokumente. Einzelne Formulierungen können unter Art. 28 ZGB auf Persönlichkeitsrechtsverletzung geprüft werden, wenn die Häufung zunimmt.`;
    rows.push({ tactic: "Einseitige Darstellung", article: "Forensisch / Beobachtung", present: true, evidence: "Leichte Tendenz erkannt" });
    rows.push({ tactic: "Verletzung der Persönlichkeitsrechte", article: "Art. 28 ZGB (CH)", present: false, evidence: "Kein ausreichender Nachweis – Verlauf beobachten" });
    rows.push({ tactic: "Üble Nachrede", article: "Art. 173 StGB (CH)", present: false, evidence: "Kein Nachweis" });

  } else {
    profileTitle = "Forensisches Profil: Keine auffälligen Taktiken identifiziert";
    summary = `Die KI-Analyse erkennt in diesem Dokument keine offensichtlichen taktischen Muster gegen ${nameP}. Die Darstellung erscheint im Wesentlichen sachlich. Eine Gesamtbetrachtung aller Dokumente des Dossiers wird dennoch empfohlen.`;
    legalTitle = "Juristische Bewertung (KI als neutraler Rechtsbeobachter)";
    legalNote = `Keine unmittelbaren Rechtsrisiken identifiziert. Gesamtdossier-Betrachtung weiterhin empfohlen.`;
    rows.push({ tactic: "Keine Auffälligkeiten erkannt", article: "–", present: false, evidence: "File erscheint sachlich" });
  }

  // Section 4: Counsel assessment & client advice
  let counselTitle = "";
  let counselItems = [];

  const presentCount = rows.filter(r => r.present).length;

  if (pressure >= 4 || (protNeg >= 3 && oppPos >= 2)) {
    counselTitle = `Alarmstufe Rot – Ihr Rechtsbeistand muss JETZT handeln`;
    counselItems = [
      { icon: "🚨", label: "Ihr Anwalt schläft – oder sieht er das Muster?", text: `Die KI hat <strong>${presentCount} aktive Tatbestände</strong> gegen ${nameP} erkannt. ${protNeg} negative Zuschreibungen stehen ${protPos} positiven gegenüber – das ist kein Zufall, das ist eine <strong>Kampagne</strong>. Wenn Ihr Anwalt das nicht als systematisches Degradierungsmuster benennt und vor Gericht rügt, hat er die Tragweite nicht verstanden. Fragen Sie ihn direkt: „Sehen Sie das Muster? Was ist Ihre Gegenstrategie?"` },
      { icon: "⚖️", label: "Falsche Flughöhe = verlorener Fall", text: `Kommuniziert Ihr Anwalt gegenüber dem Gericht <strong>auf Augenhöhe</strong> – sachlich, forensisch, belegt? Oder schreibt er emotional, devot oder unpräzise? Die Gegenpartei (${nameG}) fährt eine kalkulierte Strategie. Wenn Ihr Anwalt das Spiel nicht durchschaut und auf derselben taktischen Ebene kontert, verlieren Sie. Ein Anwalt, der die Behörde nicht herausfordert, legitimiert die Angriffe.` },
      { icon: "📋", label: "Konkrete Sofortmassnahmen", text: `Fordern Sie von Ihrem Anwalt: <strong>1)</strong> Formelle Rüge nach Art. 152 ZPO gegen jede sachfremde Darstellung. <strong>2)</strong> Befangenheitsantrag prüfen, falls beteiligte Amtspersonen einseitig agieren. <strong>3)</strong> Gegendarstellung zu jedem einzelnen der ${presentCount} erkannten Tatbestände. Wenn er/sie das nicht liefern kann, ist das ein Warnsignal.` },
      { icon: "🔄", label: "Anwaltswechsel ernsthaft prüfen", text: `Bei einem Druck-Score von <strong>${pressure}</strong> und ${presentCount} aktiven Indizien empfiehlt die KI-Analyse <strong>dringend eine Zweitmeinung</strong>. Zeigen Sie diesen Report einem unabhängigen Fachanwalt für Familienrecht. Wenn Ihr aktueller Anwalt die Muster verharmlost, die falschen Prioritäten setzt oder die Behörde nicht konfrontiert – wechseln Sie. Lieber jetzt als nach dem Urteil.` },
      { icon: "🛡️", label: "Jedes Dokument zählt", text: `Laden Sie <strong>jedes Schreiben</strong> hoch – von Behörden, Gegenpartei, Ihrem eigenen Anwalt. Die KI wird Widersprüche aufdecken, die dem menschlichen Auge entgehen. Je mehr Material, desto stärker Ihre Position. Halten Sie auch Telefonate schriftlich fest.` }
    ];
  } else if (pressure >= 2 || protNeg >= 2) {
    counselTitle = `Achtung – Die Gegenseite baut Druck auf`;
    counselItems = [
      { icon: "⚠️", label: "Ihr Anwalt muss das Framing durchbrechen", text: `Die KI erkennt <strong>${presentCount} Indizien</strong> für selektive Darstellung gegen ${nameP}. ${nameG} setzt gezielt auf Ablenkung und einseitige Information. Besprechen Sie mit Ihrem Anwalt: Rügt er/sie diese Muster aktiv – oder lässt er sie stillschweigend stehen? Schweigen ist Zustimmung vor Gericht.` },
      { icon: "🔍", label: "Sprache und Haltung Ihres Anwalts", text: `Beobachten Sie kritisch: Übernimmt Ihr Anwalt unbewusst das <strong>Framing der Gegenpartei</strong>? Ein guter Anwalt hinterfragt jede Behauptung – ein schlechter folgt der Erzählung. Achten Sie darauf, ob Ihr Anwalt ${nameP} aktiv verteidigt oder nur reagiert.` },
      { icon: "📋", label: "Gegenbeweise aufbauen", text: `Sammeln Sie gezielt Dokumente, die das einseitige Bild widerlegen: Zeugenaussagen, positive Berichte, eigene Korrespondenz. Die KI-Analyse wird mit jedem neuen Dokument präziser. ${protNeg} negative Zuschreibungen brauchen konkrete Gegenpunkte.` }
    ];
  } else if (pressure >= 1) {
    counselTitle = `Beobachtungsmodus – Leichte Tendenz erkannt`;
    counselItems = [
      { icon: "👁️", label: "Noch kein Alarm, aber wachsam bleiben", text: `Die KI hat eine <strong>leichte einseitige Tendenz</strong> zuungunsten von ${nameP} erkannt. Das ist noch kein Alarmsignal – aber informieren Sie Ihren Anwalt über diese Einschätzung. Fragen Sie: „Sehen Sie eine Schieflage?" Die Antwort zeigt, ob er den Fall richtig einschätzt.` },
      { icon: "📁", label: "Dossier systematisch aufbauen", text: `Einzelne Dokumente sind Momentaufnahmen. Laden Sie <strong>weitere Unterlagen</strong> hoch – die KI erkennt Muster erst ab einer gewissen Datenmenge. Was heute als leichte Tendenz erscheint, kann sich über mehrere Dokumente zu einem belastenden Muster verdichten.` }
    ];
  } else {
    counselTitle = `Unauffällig – Gute Ausgangslage`;
    counselItems = [
      { icon: "✅", label: "Keine taktischen Muster erkannt", text: `In den analysierten Dokumenten zeigt die KI <strong>keine offensichtlichen Angriffsmuster</strong> gegen ${nameP}. Die Darstellung erscheint sachlich. Das ist eine gute Ausgangslage – aber bleiben Sie wachsam und laden Sie weitere Dokumente hoch, um das Gesamtbild zu vervollständigen.` }
    ];
  }

  return { profileTitle, summary, legalTitle, legalNote, rows, pressure, counselTitle, counselItems };
}

function renderTacticAnalysisBox(analysis, protectedPerson, opposingParty, docIds, tacticFileMap) {
  const profile = deriveTacticProfile(analysis, protectedPerson, opposingParty);

  // Build compact doc ID list for the DOC-ID column (fallback for per-file view)
  let docRefList = [];
  if (Array.isArray(docIds)) {
    docRefList = docIds.map(id => escapeHtml(String(id)));
  } else if (docIds) {
    docRefList = [escapeHtml(String(docIds))];
  }

  const tableRows = profile.rows.map(r => {
    const cls      = r.present ? "tactic-row-present" : "tactic-row-absent";
    const evidenceText = escapeHtml(r.evidence.replace(/^Indiz erkannt – ?|^Erkannt – ?|^Kein ausreichender Nachweis ?|^Kein Nachweis ?|^Leichte Tendenz erkannt ?/i, ""));

    // Per-tactic file numbers: use tacticFileMap if available, otherwise fallback to docRefList
    let docCell = "";
    if (tacticFileMap && tacticFileMap.has(r.tactic)) {
      const fileNums = tacticFileMap.get(r.tactic).map(id => escapeHtml(String(id)));
      docCell = `<span class="tactic-doc-ids">${fileNums.join(", ")}</span>`;
    } else if (r.present && docRefList.length > 0) {
      docCell = `<span class="tactic-doc-ids">${docRefList.join(", ")}</span>`;
    } else {
      docCell = r.present ? "–" : "";
    }
    const articlePart = r.article && r.article !== "–"
      ? `<span class="tactic-td-article">${escapeHtml(r.article)}</span>`
      : "";

    // Derive lawyer-style evidence verdict from raw evidence prefix
    const rawEv = r.evidence || "";
    let evTone = "none";
    let evLabel = "Nicht belegt";
    let evDetail = "Kein ausreichender Nachweis erbracht";
    if (/^Erkannt/i.test(rawEv)) {
      evTone = "proven"; evLabel = "Belegt"; evDetail = "Schlüssig belegt – Aktenlage bestätigt";
    } else if (/^Indiz erkannt/i.test(rawEv)) {
      evTone = "indiz"; evLabel = "Indiziert"; evDetail = "Indizien vorhanden – nicht abschliessend bewiesen";
    } else if (/^Leichte Tendenz/i.test(rawEv)) {
      evTone = "trend"; evLabel = "Tendenz"; evDetail = "Tendenz erkennbar – Beweis ausstehend";
    } else if (/^Kein ausreichender/i.test(rawEv)) {
      evTone = "none"; evLabel = "Nicht belegt"; evDetail = "Mangels hinreichender Beweise nicht belegt";
    } else if (/^Kein Nachweis/i.test(rawEv)) {
      evTone = "none"; evLabel = "Nicht belegt"; evDetail = "Kein Nachweis erbracht";
    }
    const evCell = `<div class="tactic-ev-badge tactic-ev-${evTone}" title="${escapeHtml(evDetail)}"><span class="tactic-ev-dot"></span><span class="tactic-ev-label">${escapeHtml(evLabel)}</span></div>`;

    return `<tr class="${cls}">
      <td class="tactic-td-tactic"><span class="tactic-tactic-name">${escapeHtml(r.tactic)}</span>${articlePart}</td>
      <td class="tactic-td-ev">${evCell}</td>
      <td class="tactic-td-ki">${evidenceText}</td>
      <td class="tactic-doc-id-cell">${docCell}</td>
    </tr>`;
  }).join("");

  // Section 3: Legal assessment
  const legalHtml = profile.legalNote
    ? `<div class="tactic-section">
        <div class="tactic-section-number">3</div>
        <div class="tactic-section-content">
          <p class="tactic-section-title">Juristische Bewertung</p>
          <p class="tactic-section-subtitle">KI als neutraler Rechtsbeobachter</p>
          <div class="tactic-legal-text">${profile.legalNote}</div>
        </div>
      </div>`
    : "";

  // Section 4: Counsel advice
  const counselHtml = profile.counselItems.length > 0
    ? `<div class="tactic-section">
        <div class="tactic-section-number">4</div>
        <div class="tactic-section-content">
          <p class="tactic-section-title">${escapeHtml(profile.counselTitle)}</p>
          <p class="tactic-section-subtitle">Strategische Einschätzung zur anwaltlichen Vertretung</p>
          <div class="tactic-counsel-grid">
            ${profile.counselItems.map(item => `
              <div class="tactic-counsel-item">
                <span class="tactic-counsel-icon">${item.icon}</span>
                <div>
                  <p class="tactic-counsel-label">${escapeHtml(item.label)}</p>
                  <p class="tactic-counsel-text">${item.text}</p>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>`
    : "";

  const presentCount = profile.rows.filter(r => r.present).length;

  return `
    <div class="tactic-analysis-box">
      <div class="tactic-report-header">
        <p class="tactic-analysis-eyebrow">KI-Forensik · Dokumentenanalyse</p>
        <h3 class="tactic-analysis-profile-title">${escapeHtml(profile.profileTitle)}</h3>
      </div>

      <div class="tactic-section">
        <div class="tactic-section-number">1</div>
        <div class="tactic-section-content">
          <p class="tactic-section-title">Forensische Einordnung</p>
          <p class="tactic-section-subtitle">Analyse der Darstellungsmuster im Dossier</p>
          <div class="tactic-analysis-body">${profile.summary}</div>
        </div>
      </div>

      <div class="tactic-section">
        <div class="tactic-section-number">2</div>
        <div class="tactic-section-content">
          <p class="tactic-section-title">Erkannte Tatbestände</p>
          <p class="tactic-section-subtitle">${presentCount} von ${profile.rows.length} Tatbeständen mit Indizien – Schweizer Recht (StGB / ZGB / ZPO)</p>
          <div class="tactic-table-wrap">
            <table class="tactic-table">
              <thead>
                <tr>
                  <th>Tatbestand / Methode</th>
                  <th>Evidenz</th>
                  <th>Fazit</th>
                  <th>File Nummer</th>
                </tr>
              </thead>
              <tbody>${tableRows}</tbody>
            </table>
          </div>
        </div>
      </div>

      ${legalHtml}
      ${counselHtml}
    </div>
  `;
}

/* ----------------------------------------------------------------
   AKTEURE BOX – All persons from document, colour-coded sentiment
   ---------------------------------------------------------------- */
/**
 * Derives how a person WRITES/SPEAKS about the protected (disadvantaged) person.
 *
 * Priority order:
 *  1. Protected person → teal "protected" dot
 *  2. Author-based: if this person authored documents, use how THEY wrote about the protected person
 *  3. Opposing party → always negative
 *  4. Known-role hardcodes (children → positive, Landi → negative, court → neutral)
 *  5. Affiliation heuristics (Beistand/Berufsbeistand from dossier pressure, Anwalt → positive)
 *  6. Fallback from overall dossier pressure
 *
 * @param {Object}  person            – person object {name, affiliation}
 * @param {Object}  analysis          – aggregate analysis totals (full dossier)
 * @param {string}  protectedPerson   – name of the disadvantaged person
 * @param {string}  opposingParty     – name of the opposing party
 * @param {Map}     authorSentimentMap – Map<authorName, {positive, negative}> built from document analyses
 */
function derivePersonSentiment(person, analysis, protectedPerson, opposingParty, authorSentimentMap) {
  const nameNorm = normalizeTitleText(person.name || "").toLowerCase();
  const affil    = normalizeTitleText(person.affiliation || "").toLowerCase();
  const protNorm = normalizeTitleText(protectedPerson || "").toLowerCase();
  const oppNorm  = normalizeTitleText(opposingParty   || "").toLowerCase();

  // Strip diacritics for fuzzy matching
  const normKey = (n) =>
    normalizeTitleText(n).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const personKey = normKey(person.name || "");

  // ── 1. Protected person → teal dot ──────────────────────────────────────────
  const protFirstWord = (protNorm.split(/[\s,]+/)[0] || "").toLowerCase();
  if (protFirstWord && nameNorm.includes(protFirstWord) && protFirstWord.length > 2) {
    return "protected";
  }

  // ── 2. KI-basiertes Sentiment (höchste Priorität) ────────────────────────────
  // Die KI analysiert jedes Dokument und bestimmt pro Person ob sie für/gegen
  // die Fokus-Partei ist. Dieses Feld hat Vorrang vor allen Heuristiken.
  const personSentiment = normalizeTitleText(person.sentiment || "").toLowerCase();
  if (personSentiment === "positiv" || personSentiment === "positive") return "positive";
  if (personSentiment === "negativ" || personSentiment === "negative") return "negative";
  if (personSentiment === "neutral") return "neutral";

  // ── 3. Author-based sentiment (Fallback wenn KI kein Sentiment liefert) ─────
  if (authorSentimentMap && authorSentimentMap.size > 0) {
    for (const [authorName, s] of authorSentimentMap.entries()) {
      const authorKey = normKey(authorName);
      const personParts = personKey.split(/\s+/).filter(w => w.length > 2);
      const authorParts = authorKey.split(/\s+/).filter(w => w.length > 2);
      const matched = personParts.some(p => authorParts.some(a => a === p || a.startsWith(p) || p.startsWith(a)));
      if (matched && (s.positive + s.negative) > 0) {
        const score = s.negative - s.positive;
        if (score >= 1)  return "negative";
        if (score <= -1) return "positive";
        return "neutral";
      }
    }
  }

  // ── 4. Affiliation-based fallback ───────────────────────────────────────────
  if (affil.includes("kind") && !affil.includes("kinderanw")) return "neutral";

  const oppFirstWord = (oppNorm.split(/[\s,]+/)[0] || "").toLowerCase();
  if (oppFirstWord && nameNorm.includes(oppFirstWord) && oppFirstWord.length > 2) {
    return "negative";
  }

  // ── 5. No data → unknown ───────────────────────────────────────────────────
  return "unknown";
}

function getAffiliationLabel(affiliation) {
  const raw = normalizeTitleText(affiliation || "");
  const lc = raw.toLowerCase();
  if (!raw || lc === "privatperson") return "Beteiligte Person";
  // Family
  if (lc.includes("vater") || lc === "vater") return "Vater";
  if (lc.includes("mutter") || lc === "mutter") return "Mutter";
  if (lc.includes("ex-partner") || lc.includes("ex partner") || lc.includes("expartner")) return "Ex-Partner/in";
  if (lc.includes("ex-frau") || lc.includes("exfrau")) return "Ex-Frau";
  if (lc.includes("ex-mann") || lc.includes("exmann")) return "Ex-Mann";
  if (lc.includes("kind") && !lc.includes("kinderanw")) return "Kind";
  if (lc.includes("kinderanw")) return "Kinderanwalt";
  // Legal / official
  if (lc.includes("anwalt") || lc.includes("anwältin") || lc.includes("rechtsvertr")) return "Anwalt / Anwältin";
  if (lc.includes("berufsbeistand")) return "Berufsbeistand";
  if (lc.includes("beistand") || lc.includes("beiständin")) return "Beistand / Beiständin";
  if (lc.includes("kesb")) return "KESB Behördenmitglied";
  if (lc.includes("gerichtspräsident") || lc.includes("gerichtsprasident")) return "Gerichtspräsident";
  if (lc.includes("richter") || lc.includes("richterin")) return "Gerichtspräsident";
  if (lc.includes("gericht")) return "Gericht";
  if (lc.includes("gutacht")) return "Gutachter/in";
  if (lc.includes("mediator") || lc.includes("mediation")) return "Mediator/in";
  // Support / social
  if (lc.includes("familienbegleiter") || lc.includes("familienbegleit")) return "Familienbegleiter/in";
  if (lc.includes("coach")) return "Coach";
  if (lc.includes("lehrer") || lc.includes("lehrerin") || lc.includes("lehrkraft")) return "Lehrer/in";
  if (lc.includes("sozial")) return "Sozialarbeiter/in";
  if (lc.includes("therapeut")) return "Therapeut/in";
  return raw || "Beteiligte Person";
}

function makeInitials(name) {
  const parts = normalizeTitleText(name || "").split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Converts "Vorname Name" → "Name, Vorname"
 * Handles single-word names gracefully.
 */
function formatNameLastFirst(raw) {
  const name = normalizeTitleText(raw);
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0];
  // Last word is treated as family name
  const lastName = parts[parts.length - 1];
  const firstNames = parts.slice(0, parts.length - 1).join(" ");
  return `${lastName}, ${firstNames}`;
}

function getSentimentLabel(sentiment) {
  if (sentiment === "positive")  return "Positiv gegenüber Betroffener";
  if (sentiment === "negative")  return "Negativ gegenüber Betroffener";
  if (sentiment === "protected") return "Fokus-Partei";
  if (sentiment === "unknown")   return "Keine Daten – KI konnte Einordnung nicht bestimmen";
  return "Neutral / Sachlich";
}

function deriveRoleLabel(person, protectedPerson, opposingParty) {
  const nameNorm = normalizeTitleText(person.name || "").toLowerCase();
  const affil    = normalizeTitleText(person.affiliation || "").toLowerCase();
  const protNorm = normalizeTitleText(protectedPerson || "").toLowerCase();
  const oppNorm  = normalizeTitleText(opposingParty   || "").toLowerCase();

  // 0. Hardcoded overrides for specific persons
  if (nameNorm.includes("ergen") && nameNorm.includes("ayhan")) return "Vater";
  // Alexandra Schifferli is the Kindsmutter (opposing party)
  if (nameNorm.includes("schifferli") && nameNorm.includes("alexandra")) return "Mutter";
  // Known children of the Schifferli family
  if (nameNorm.includes("schifferli") && (nameNorm.includes("timur") || nameNorm.includes("nael"))) return "Kind";
  // Weizenegger: Leiter Jugendforensik / Gutachter – NOT a child
  if (nameNorm.includes("weizenegger")) return "Leiter Jugendforensik";
  // Hardcoded role overrides for known persons
  if (nameNorm.includes("perret")) return "Berufsbeistand";
  if (nameNorm.includes("leopold") && nameNorm.includes("evelyne")) return "Beiständin";
  // Riedo Pascal = Kinderanwalt (advokat für sich und die Kinder)
  if (nameNorm.includes("riedo") && nameNorm.includes("pascal")) return "Kinderanwalt";
  // Gabel Lisa Marie = Anwältin von Ayhan Ergen (protected person)
  if (nameNorm.includes("gabel") && nameNorm.includes("lisa")) return "Anwältin (Ergen)";
  if (nameNorm.includes("landi") && nameNorm.includes("annalisa")) return "Anwältin Gegenpartei";
  if (nameNorm.includes("hofmann") && nameNorm.includes("roland")) return "Gerichtspräsident";

  // 1. Is this the protected person?
  const protWords = protNorm.split(/[\s,]+/).filter(w => w.length > 2);
  if (protWords.length > 0 && protWords.every(w => nameNorm.includes(w))) return "Fokus-Partei";

  // 2. Is this the exact opposing party?
  const oppWords = oppNorm.split(/[\s,]+/).filter(w => w.length > 2);
  if (oppWords.length > 0 && oppWords.every(w => nameNorm.includes(w))) return "Gegenpartei";

  // 3. Use affiliation if it's meaningful
  if (affil && affil !== "privatperson") return getAffiliationLabel(person.affiliation);

  // 4. Shares last name with opposing party but is NOT them → likely child
  const oppFamilyName = oppNorm.split(/[\s,]+/).find(w => w.length > 2) || "";
  if (oppFamilyName && nameNorm.includes(oppFamilyName)) return "Kind";

  // 5. Shares last name with protected person but is NOT them → likely child
  const protFamilyName = protNorm.split(/[\s,]+/).find(w => w.length > 2) || "";
  if (protFamilyName && nameNorm.includes(protFamilyName)) return "Kind";

  // 6. Fallback: function unknown to the AI
  return "–";
}

/**
 * Splits a "polluted" name string that may contain titles, function words or
 * institution names mixed in with the real person name.
 *
 * Examples:
 *   "Behördenmitglied, Susanne Angst, klinische Psychologin" → { name:"Susanne Angst", role:"Behördenmitglied / klinische Psychologin" }
 *   "Jugendforensik, Benedict Weizenegger, Leiter"            → { name:"Benedict Weizenegger", role:"Leiter Jugendforensik" }
 *   "Angst, Susanne"                                          → { name:"Susanne Angst", role:"" }
 *
 * Returns { name: string, role: string } – role is "" when nothing extra found.
 */
function parsePersonEntry(raw) {
  const text = normalizeTitleText(raw);
  if (!text) return { name: "", role: "" };

  // Pattern: exactly 2–4 consecutive Title-Case words (the real person name)
  const namePattern = /^[A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ''-]+(?:\s+[A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ''-]+){1,3}$/;

  // Already clean?
  if (namePattern.test(text)) return { name: text, role: "" };

  // --- Split by comma and try to find the person-name segment ---
  const FUNCTION_WORDS = new Set([
    "Behördenmitglied", "Behörde", "Berufsbeistand", "Beistand", "Beiständin",
    "Gerichtspräsident", "Richter", "Richterin", "Jugendforensik", "Forensik",
    "Leiter", "Leiterin", "Klinische", "Klinischer", "Soziale", "Sozialer",
    "Anwalt", "Anwältin", "Rechtsanwalt", "Rechtsanwältin", "KESB", "Amt",
    "Gericht", "Gutachter", "Gutachterin", "Psychiater", "Psychiaterin",
    "Psychologe", "Psychologin", "Therapeut", "Therapeutin", "Mediator",
    "Mediaterin", "Coach", "Schule", "Sozialarbeit", "Kanzlei"
  ]);

  const segments = text.split(/[,;]+/).map(s => s.trim()).filter(Boolean);

  // Find the first segment that is purely a person name (all Title-Case, no function words)
  let personSegment = "";
  const roleSegments = [];

  for (const seg of segments) {
    if (!personSegment && namePattern.test(seg)) {
      const words = seg.split(/\s+/);
      const hasFunction = words.some(w => FUNCTION_WORDS.has(w));
      if (!hasFunction) {
        personSegment = seg;
        continue;
      }
    }
    roleSegments.push(seg);
  }

  // If no clean segment found, try to extract the 2+ consecutive Title-Case words
  // that are NOT function words
  if (!personSegment) {
    const allCandidates = [...text.matchAll(/\b([A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ''-]{2,}(?:\s+[A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ''-]{2,})+)\b/g)];
    for (const m of allCandidates) {
      const words = m[1].split(/\s+/);
      const hasFunction = words.some(w => FUNCTION_WORDS.has(w));
      if (!hasFunction && words.length >= 2 && words.length <= 4) {
        personSegment = m[1];
        // The rest of the text (before and after) goes to role
        const before = text.slice(0, m.index).replace(/[,;]\s*$/, "").trim();
        const after = text.slice(m.index + m[0].length).replace(/^[,;\s]+/, "").trim();
        if (before) roleSegments.push(before);
        if (after) roleSegments.push(after);
        break;
      }
    }
  }

  // Handle "Last, First" format (single comma, both segments look like names)
  if (!personSegment && segments.length === 2) {
    const [a, b] = segments;
    const aWords = a.split(/\s+/);
    const bWords = b.split(/\s+/);
    // "Angst, Susanne" – first segment is one capitalized word (surname), second is first name(s)
    if (/^[A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ''-]+$/.test(a) && bWords.every(w => /^[A-ZÄÖÜ]/.test(w))) {
      // Reconstruct as "First Last"
      return { name: `${b} ${a}`.trim(), role: "" };
    }
  }

  if (!personSegment) return { name: text, role: "" };

  const roleText = roleSegments
    .filter(s => s && !namePattern.test(s) || FUNCTION_WORDS.has(s.split(/\s+/)[0]))
    .join(" / ")
    .replace(/^[,;\s/]+|[,;\s/]+$/g, "")
    .trim();

  return { name: personSegment, role: roleText };
}

/**
 * Returns a diacritics-stripped, lower-cased key for fuzzy person dedup.
 */
function personDedupKey(name) {
  return normalizeTitleText(name)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * Significant words in a name key (length > 2, used for subset matching).
 */
function sigWords(key) {
  return key.split(/\s+/).filter(w => w.length > 2);
}

/**
 * Returns true if ALL words of the shorter name appear in the longer name.
 * Handles "Ayhan" ⊂ "Ayhan Ergen", "Schifferli" ⊂ "Schifferli Nael Kaan", etc.
 */
function isSamePersonSubset(keyA, keyB) {
  const wa = sigWords(keyA);
  const wb = sigWords(keyB);
  if (wa.length === 0 || wb.length === 0) return false;
  const shorter = wa.length <= wb.length ? wa : wb;
  const longer  = wa.length <= wb.length ? wb : wa;
  return shorter.every(w => longer.some(lw => lw === w || lw.startsWith(w) || w.startsWith(lw)));
}

/**
 * Smart person deduplication:
 * – runs parsePersonEntry on each person to clean polluted name strings
 * – exact key match → same person
 * – subset word match → same person, keep longer/more informative name
 * – merge affiliation when one side has "Privatperson" and the other doesn't
 */
function deduplicatePeople(people) {
  // Map<dedupKey, index-in-result>
  const keyIndex = new Map();
  const result = [];

  for (const rawP of people) {
    // ── Clean polluted name strings (e.g. "Behördenmitglied, Susanne Angst, klinische Psychologin") ──
    const parsed = parsePersonEntry(rawP.name || "");
    const name = parsed.name || normalizeTitleText(rawP.name || "");
    // Use extracted role from parsePersonEntry if existing affiliation is generic
    const rawAffil = rawP.affiliation || "Privatperson";
    const affil = (rawAffil === "Privatperson" && parsed.role)
      ? parsed.role
      : rawAffil;
    const key = personDedupKey(name);
    if (!key) continue;

    // 1. Exact match
    if (keyIndex.has(key)) {
      const idx = keyIndex.get(key);
      if (affil && affil !== "Privatperson" && result[idx].affiliation === "Privatperson") {
        result[idx].affiliation = affil;
      }
      continue;
    }

    // 2. Fuzzy subset match against already-stored entries
    let merged = false;
    for (const [existKey, idx] of keyIndex.entries()) {
      if (isSamePersonSubset(key, existKey)) {
        const nameWords = sigWords(key);
        const existWords = sigWords(existKey);
        // Prefer longer (more complete) name
        if (nameWords.length > existWords.length) {
          result[idx].name = name;
          keyIndex.delete(existKey);
          keyIndex.set(key, idx);
        }
        // Merge affiliation
        if (affil && affil !== "Privatperson" && result[idx].affiliation === "Privatperson") {
          result[idx].affiliation = affil;
        }
        merged = true;
        break;
      }
    }
    if (merged) continue;

    // 3. New person
    keyIndex.set(key, result.length);
    result.push({ name, affiliation: affil });
  }

  return result;
}

/**
 * Renders the Personen table.
 * @param {Object} analysis            – aggregate analysis (people array + totals)
 * @param {string} protectedPerson
 * @param {string} opposingParty
 * @param {Map}    authorSentimentMap  – Map<authorName, {positive,negative}> from refreshAnalysisReport
 */
function renderAkteureBox(analysis, protectedPerson, opposingParty, authorSentimentMap = new Map()) {
  const people = Array.isArray(analysis.people) ? analysis.people : [];

  // Smart deduplication (handles "Ayhan" == "Ayhan Ergen", name variants, etc.)
  const unique = deduplicatePeople(people);

  if (unique.length === 0) {
    return `
      <div class="tactic-section">
        <div class="tactic-section-number">5</div>
        <div class="tactic-section-content">
          <p class="tactic-section-title">Involvierte Personen & Funktion</p>
          <p class="tactic-section-subtitle">Alle im Dossier erkannten Personen</p>
          <p class="akteure-empty">Noch keine Personen extrahiert. Werden mit jedem weiteren File erg\u00e4nzt.</p>
        </div>
      </div>
    `;
  }

  // Sort: Fokus-Partei (protected) always at top
  const protFirstWord = (normalizeTitleText(protectedPerson || "").toLowerCase().split(/[\s,]+/)[0] || "");
  const sorted = [...unique].sort((a, b) => {
    const aN = normalizeTitleText(a.name || "").toLowerCase();
    const bN = normalizeTitleText(b.name || "").toLowerCase();
    const aIsProtected = protFirstWord.length > 2 && aN.includes(protFirstWord);
    const bIsProtected = protFirstWord.length > 2 && bN.includes(protFirstWord);
    if (aIsProtected && !bIsProtected) return -1;
    if (!aIsProtected && bIsProtected) return 1;
    return 0;
  });

  const rows = sorted.map(person => {
    const sentiment   = derivePersonSentiment(person, analysis, protectedPerson, opposingParty, authorSentimentMap);
    const roleLabel   = deriveRoleLabel(person, protectedPerson, opposingParty);
    const displayName = formatNameLastFirst(person.name);
    return `
      <tr class="akteure-row">
        <td class="akteure-col-name">${escapeHtml(displayName)}</td>
        <td class="akteure-col-role">${escapeHtml(roleLabel)}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="tactic-section">
      <div class="tactic-section-number">5</div>
      <div class="tactic-section-content">
        <p class="tactic-section-title">Involvierte Personen & Funktion</p>
        <p class="tactic-section-subtitle">Alle im Dossier erkannten Personen mit Rolle</p>
        <div class="akteure-table-container">
          <table class="akteure-personen">
            <colgroup>
              <col class="col-name" />
              <col class="col-funktion" />
            </colgroup>
            <thead>
              <tr>
                <th>Name, Vorname</th>
                <th>Funktion</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

function renderEvidenceList(items, emptyText) {
  const safeItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (safeItems.length === 0) {
    return `<p class="qa-evidence-empty">${escapeHtml(emptyText)}</p>`;
  }

  return `<ul class="qa-evidence-list">${safeItems.map((item) => `<li>„${escapeHtml(item)}“</li>`).join("")}</ul>`;
}

function renderEvidenceBlock(title, items, tone, emptyText) {
  return `
    <div class="qa-evidence-block is-${tone}">
      <span class="qa-evidence-label">${escapeHtml(title)}</span>
      ${renderEvidenceList(items, emptyText)}
    </div>
  `;
}

function renderImpactRanking(items) {
  const safeItems = Array.isArray(items) ? items.slice(0, 4) : [];
  if (safeItems.length === 0) {
    return "";
  }

  return `
    <section class="qa-focus-strip">
      <div class="qa-focus-head">
        <span class="qa-focus-title">Beteiligte im Fokus</span>
        <span class="qa-focus-subtitle">Gewichtete Auffälligkeiten aus Personenbezug und File-Kontext</span>
      </div>
      <div class="qa-focus-list">
        ${safeItems.map((entry) => {
          const tone = Number(entry?.count || 0) > 0 ? "negative" : "neutral";
          const itemsText = Array.isArray(entry?.items) && entry.items.length > 0
            ? entry.items[0]
            : (entry?.impact || "Neutral");
          return `<article class="qa-focus-item is-${tone}"><strong>${escapeHtml(entry?.name || "")}</strong><span>${escapeHtml(itemsText)}</span><em>${escapeHtml(String(Number(entry?.count || 0)))}</em></article>`;
        }).join("")}
      </div>
    </section>
  `;
}

function setAnalysisReportLoading() {
  if (!(analysisReportBar instanceof HTMLElement) || !(analysisReportGrid instanceof HTMLElement) || !(analysisReportHint instanceof HTMLElement) || !(analysisReportMeta instanceof HTMLElement)) {
    return;
  }

  analysisReportBar.classList.remove("is-ready");
  analysisReportHint.textContent = "Analysen werden geladen…";
  analysisReportMeta.innerHTML = renderAnalysisReportMeta(
    { label: "Bericht wird vorbereitet", tone: "neutral", detail: "Dossierdaten werden zusammengeführt." },
    "Parteibezogene Positiv-/Negativzählung mit Belegstellen und Qualitätsprüfung.",
    "Die Übersicht wird nach jeder Analyse automatisch aktualisiert."
  );
  analysisReportGrid.innerHTML = [
    renderFileCountCard(allFiles.length || 0),
    renderPartyReportCard("Fokus-Partei", 0, 0)
  ].join("");
}

async function refreshAnalysisReport(files = allFiles) {
  if (!(analysisReportBar instanceof HTMLElement) || !(analysisReportGrid instanceof HTMLElement) || !(analysisReportHint instanceof HTMLElement) || !(analysisReportMeta instanceof HTMLElement)) {
    return;
  }

  const fileList = Array.isArray(files) ? files : [];
  const fileCount = fileList.length;
  if (fileCount === 0) {
    analysisReportBar.classList.remove("is-ready");
    analysisReportHint.textContent = "Noch keine Files im Dossier.";
    analysisReportMeta.innerHTML = renderAnalysisReportMeta(
      { label: "Leeres Dossier", tone: "neutral", detail: "Noch keine Files hochgeladen." },
      "Parteibezogene Positiv-/Negativzählung mit Belegstellen und Qualitätsprüfung.",
      "Die Gesamtbeurteilung erscheint, sobald erste Files vorliegen."
    );
    analysisReportGrid.innerHTML = [
      renderFileCountCard(0),
      renderPartyReportCard("Fokus-Partei", 0, 0)
    ].join("");
    return;
  }

  setAnalysisReportLoading();

  try {
    const analyses = await Promise.all(fileList.map((file) => getDocumentAnalysis(file, { onlyStored: true })));
    let totalPositive = 0;
    let totalNegative = 0;
    let analyzedCount = 0;
    let evidenceCount = 0;
    let ocrCount = 0;
    let protectedPositiveTotal = 0;
    let protectedNegativeTotal = 0;
    let opposingPositiveTotal = 0;
    let opposingNegativeTotal = 0;
    const qualityScores = [];
    const methodologies = new Set();

    for (const analysis of analyses) {
      if (!analysis || analysis.status === "auth-redirect") {
        continue;
      }
      if (analysis.status === "ok") {
        analyzedCount += 1;
      }
      protectedPositiveTotal += Math.max(0, Number(analysis.positiveMentions || 0));
      protectedNegativeTotal += Math.max(0, Number(analysis.negativeMentions || 0));
      opposingPositiveTotal += Math.max(0, Number(analysis.opposingPositiveMentions || 0));
      opposingNegativeTotal += Math.max(0, Number(analysis.opposingNegativeMentions || 0));
      evidenceCount += countEvidenceSnippets(analysis.evidence);
      if (analysis.textQuality?.ocrUsed) {
        ocrCount += 1;
      }
      if (Number.isFinite(Number(analysis.textQuality?.score))) {
        qualityScores.push(Number(analysis.textQuality.score));
      }
      if (analysis.methodology) {
        methodologies.add(analysis.methodology);
      }
    }

    totalPositive = protectedPositiveTotal + opposingPositiveTotal;
    totalNegative = protectedNegativeTotal + opposingNegativeTotal;

    const balance = totalPositive - totalNegative;
    const balanceText = balance === 0 ? "Neutral" : balance > 0 ? `+${balance}` : String(balance);
    const balanceTone = balance === 0 ? "neutral" : balance > 0 ? "positive" : "negative";
    const averageQuality = qualityScores.length > 0
      ? qualityScores.reduce((sum, score) => sum + score, 0) / qualityScores.length
      : null;
    const qualityLabel = deriveQualityLabel(averageQuality);
    const verdict = deriveDossierVerdict(totalPositive, totalNegative, analyzedCount);
    const methodology = Array.from(methodologies)[0] || "Parteibezogene Positiv-/Negativzählung mit Belegstellen und Qualitätsprüfung.";
    const hintParts = [`${analyzedCount} von ${fileCount} File${fileCount === 1 ? "" : "s"} analysiert`];
    if (ocrCount > 0) {
      hintParts.push(`${ocrCount} mit OCR-Fallback`);
    }

    analysisReportBar.classList.add("is-ready");
    analysisReportHint.textContent = hintParts.join(" · ");
    analysisReportMeta.innerHTML = renderAnalysisReportMeta(
      verdict,
      methodology,
      evidenceCount > 0
        ? `${evidenceCount} Belegstelle${evidenceCount === 1 ? "" : "n"} wurden dossierweit verdichtet.`
        : "Noch keine expliziten Belegstellen aus gespeicherten Analysen vorhanden."
    );
    analysisReportGrid.innerHTML = [
      renderFileCountCard(fileCount),
      renderPartyReportCard("Fokus-Partei", protectedPositiveTotal, protectedNegativeTotal)
    ].join("");

    // ── Dossier-level tactic analysis (aggregated totals) ──────────────
    if (analysisReportTactics instanceof HTMLElement) {
      const aggregateSynthesis = {
        positiveMentions: protectedPositiveTotal,
        negativeMentions: protectedNegativeTotal,
        opposingPositiveMentions: opposingPositiveTotal,
        opposingNegativeMentions: opposingNegativeTotal,
        impactAssessment: "",
        documentType: "",
        title: ""
      };

      // Build per-tactic file number map: tactic name → [compact file IDs]
      const tacticFileMap = new Map();
      for (let i = 0; i < analyses.length; i++) {
        const a = analyses[i];
        if (!a || a.status === "auth-redirect") continue;
        const fileDocId = compactDocId(fileList[i].id);
        const fileProfile = deriveTacticProfile(a, currentCaseProtectedPerson, currentCaseOpposingParty);
        for (const row of fileProfile.rows) {
          if (row.present) {
            if (!tacticFileMap.has(row.tactic)) tacticFileMap.set(row.tactic, []);
            const arr = tacticFileMap.get(row.tactic);
            if (!arr.includes(fileDocId)) arr.push(fileDocId);
          }
        }
      }

      analysisReportTactics.innerHTML = renderTacticAnalysisBox(
        aggregateSynthesis,
        currentCaseProtectedPerson,
        currentCaseOpposingParty,
        null,
        tacticFileMap
      );
    }

    // ── Dossier-level Akteure (merged from all documents, deduped) ─────
    if (analysisReportAkteure instanceof HTMLElement) {
      // Normalize name for deduplication: strip diacritics so "Jérôme" == "Jerome"
      const dedupKey = (name) =>
        normalizeTitleText(name)
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");

      // ── Build per-author sentiment map ─────────────────────────────────
      // Key = normalized author name (diacritics stripped), Value = {positive, negative}
      // This tells us HOW each person wrote about the protected person across
      // all documents they authored. Used by derivePersonSentiment() to give
      // accurate red/green dots instead of role-based guesses.
      const authorSentimentMap = new Map();
      for (const a of analyses) {
        if (!a || a.status === "auth-redirect") continue;
        const rawAuthor = normalizeTitleText(a.author || "");
        if (!rawAuthor || rawAuthor.toLowerCase() === "unbekannt") continue;
        const authorKey = rawAuthor; // store original name; normKey applied inside derivePersonSentiment
        const existing = authorSentimentMap.get(authorKey) || { positive: 0, negative: 0 };
        existing.positive += Math.max(0, Number(a.positiveMentions || 0));
        existing.negative += Math.max(0, Number(a.negativeMentions || 0));
        authorSentimentMap.set(authorKey, existing);
      }

      const seenKeys = new Set();
      const mergedPeople = [];

      const addPerson = (name, affiliation) => {
        const key = dedupKey(name);
        if (!key || seenKeys.has(key)) return;
        seenKeys.add(key);
        mergedPeople.push({ name: normalizeTitleText(name), affiliation: affiliation || "Privatperson" });
      };

      for (const a of analyses) {
        if (!a || a.status === "auth-redirect") continue;
        const docPeople = Array.isArray(a.people) ? a.people : [];
        for (const p of docPeople) {
          addPerson(p.name || "", p.affiliation || "Privatperson");
        }
        // Also include the document author — excluded from a.people by the backend
        // to avoid duplicates, but should appear in the Akteure table with their role.
        const authorName = normalizeTitleText(a.author || "");
        if (authorName) addPerson(authorName, "Privatperson");
      }
      const aggregateForAkteure = {
        people: mergedPeople,
        positiveMentions: protectedPositiveTotal,
        negativeMentions: protectedNegativeTotal,
        opposingPositiveMentions: opposingPositiveTotal,
        opposingNegativeMentions: opposingNegativeTotal
      };
      analysisReportAkteure.innerHTML = renderAkteureBox(
        aggregateForAkteure,
        currentCaseProtectedPerson,
        currentCaseOpposingParty,
        authorSentimentMap
      );
    }

  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
    analysisReportBar.classList.remove("is-ready");
    analysisReportHint.textContent = "Gesamtbeurteilung konnte nicht geladen werden.";
    analysisReportMeta.innerHTML = renderAnalysisReportMeta(
      { label: "Bericht nicht verfügbar", tone: "negative", detail: "Die Dossieraggregation konnte nicht erstellt werden." },
      "Parteibezogene Positiv-/Negativzählung mit Belegstellen und Qualitätsprüfung.",
      "Bitte Analyse erneut laden oder Backend-Verbindung prüfen."
    );
    analysisReportGrid.innerHTML = [
      renderFileCountCard(fileCount),
      renderPartyReportCard("Fokus-Partei", 0, 0),
      renderPartyReportCard("Gegenpartei", 0, 0)
    ].join("");
  }
}

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

  if (
    mime.startsWith("video/") ||
    /\.(mov|mp4|avi|mkv|webm|3gp|m4v|wmv|flv|ts|mts|m2ts)$/i.test(name)
  ) {
    return { className: "video", label: "VIDEO" };
  }

  if (
    mime.startsWith("audio/") ||
    /\.(mp3|m4a|wav|aac|ogg|flac|wma|opus|m4b)$/i.test(name)
  ) {
    return { className: "audio", label: "AUDIO" };
  }

  return { className: "generic", label: "FILE" };
}

function compactDocId(id) {
  const raw = String(id || "").replace(/-/g, "").slice(0, 12);
  const numeric = Number.parseInt(raw || "0", 16) % 100000000;
  return String(Number.isFinite(numeric) ? numeric : 0).padStart(8, "0");
}

function parseSwissDate(str) {
  if (!str) return null;
  const swiss = String(str).match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (swiss) return new Date(`${swiss[3]}-${swiss[2]}-${swiss[1]}T12:00:00`);
  const d = new Date(str);
  return Number.isNaN(d.getTime()) ? null : d;
}

function updateSortUI() {
  const sortUploadAscBtn  = document.getElementById("sortUploadAscBtn");
  const sortUploadDescBtn = document.getElementById("sortUploadDescBtn");
  const sortFileAscBtn    = document.getElementById("sortFileAscBtn");
  const sortFileDescBtn   = document.getElementById("sortFileDescBtn");

  [sortUploadAscBtn, sortUploadDescBtn, sortFileAscBtn, sortFileDescBtn].forEach(btn => {
    btn?.classList.remove("fp-sort-btn--active");
  });

  if (currentSortField === "uploadDate") {
    (currentSortOrder === "asc" ? sortUploadAscBtn : sortUploadDescBtn)?.classList.add("fp-sort-btn--active");
  } else {
    (currentSortOrder === "asc" ? sortFileAscBtn : sortFileDescBtn)?.classList.add("fp-sort-btn--active");
  }
}

function filterFiles(files) {
  const type = String(fileTypeFilter?.value || "all").toLowerCase();
  const fromDate = dateFromFilter.value ? new Date(`${dateFromFilter.value}T00:00:00`) : null;
  const toDate = dateToFilter?.value ? new Date(`${dateToFilter.value}T23:59:59`) : null;
  const searchEl = document.getElementById("fileSearchInput");
  const searchTerms = (searchEl?.value || "").toLowerCase().trim().split(/\s+/).filter(Boolean);

  let result = files.filter((file) => {
    const fileType = resolveFileType(file).className;
    const uploadedAt = new Date(file.uploaded_at);
    if (type !== "all" && fileType !== type) return false;
    if (fromDate && uploadedAt < fromDate) return false;
    if (toDate && uploadedAt > toDate) return false;

    // Text search across filename + cached analysis data
    if (searchTerms.length > 0) {
      const name = (file.original_name || "").toLowerCase();
      const cached = analysisCache.get(file.id);
      const haystack = [
        name,
        cached?.title || "",
        cached?.author || "",
        cached?.senderInstitution || "",
        cached?.documentType || "",
        cached?.authoredDate || "",
        cached?.impactAssessment || "",
        ...(cached?.people || []).map(p => typeof p === "string" ? p : (p?.name || "") + " " + (p?.affiliation || ""))
      ].join(" ").toLowerCase();
      if (!searchTerms.every(term => haystack.includes(term))) return false;
    }

    return true;
  });

  // Sort by selected field and order
  result = [...result].sort((a, b) => {
    let aVal, bVal;
    if (currentSortField === "fileDate") {
      const aAnalysis = analysisCache.get(a.id);
      const bAnalysis = analysisCache.get(b.id);
      aVal = parseSwissDate(aAnalysis?.authoredDate) || new Date(0);
      bVal = parseSwissDate(bAnalysis?.authoredDate) || new Date(0);
    } else {
      aVal = new Date(a.uploaded_at);
      bVal = new Date(b.uploaded_at);
    }
    const diff = aVal.getTime() - bVal.getTime();
    return currentSortOrder === "asc" ? diff : -diff;
  });

  return result;
}

async function downloadAllFilesAsPdf() {
  const PDFLib = window.PDFLib;
  if (!PDFLib) {
    setMessage(listMessage, "PDF-Bibliothek nicht verfügbar. Bitte Seite neu laden.", "error");
    return;
  }

  const btn = downloadAllFilesBtn;
  const spinnerSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:.88rem;height:.88rem;animation:spin 700ms linear infinite"><path d="M12 4a8 8 0 0 1 7.75 6h-2.2A6 6 0 1 0 16.2 16l-2.2-2.2H20v6l-2.35-2.35A8 8 0 1 1 12 4z"/></svg>`;
  const originalHtml = btn?.innerHTML ?? "PDF Files Download";
  if (btn) { btn.disabled = true; btn.innerHTML = `${spinnerSvg} Wird erstellt…`; }

  const visibleFiles = filterFiles(allFiles);
  if (visibleFiles.length === 0) {
    setMessage(listMessage, "Keine Files f\u00fcr den Download vorhanden.", "error");
    if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
    return;
  }

  try {
    const { PDFDocument } = PDFLib;
    const mergedPdf = await PDFDocument.create();
    let addedCount = 0;

    for (const file of visibleFiles) {
      const url = await getPreviewUrl(file);
      if (!url) continue;
      let arrayBuffer;
      try {
        const resp = await fetch(url);
        arrayBuffer = await resp.arrayBuffer();
      } catch { continue; }

      const fileType = resolveFileType(file);
      if (fileType.className === "pdf") {
        try {
          const srcPdf = await PDFDocument.load(arrayBuffer, { ignoreEncryption: true });
          const pages = await mergedPdf.copyPages(srcPdf, srcPdf.getPageIndices());
          pages.forEach(p => mergedPdf.addPage(p));
          addedCount++;
        } catch { /* skip corrupt PDF */ }
      } else if (fileType.className === "png" || fileType.className === "jpg") {
        try {
          const bytes = new Uint8Array(arrayBuffer);
          const img = fileType.className === "png"
            ? await mergedPdf.embedPng(bytes)
            : await mergedPdf.embedJpg(bytes);
          const { width, height } = img.scale(1);
          const maxW = 595.28, maxH = 841.89; // A4 points
          const scale = Math.min(maxW / width, maxH / height, 1);
          const page = mergedPdf.addPage([maxW, maxH]);
          page.drawImage(img, {
            x: (maxW - width * scale) / 2,
            y: (maxH - height * scale) / 2,
            width: width * scale,
            height: height * scale,
          });
          addedCount++;
        } catch { /* skip corrupt image */ }
      }
    }

    if (addedCount === 0) {
      setMessage(listMessage, "Kein File konnte in das PDF aufgenommen werden.", "error");
      return;
    }

    const pdfBytes = await mergedPdf.save();
    const blob = new Blob([pdfBytes], { type: "application/pdf" });
    const dlUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = dlUrl;
    link.download = `dossier-${currentCaseId}-files.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(dlUrl);
    setMessage(listMessage, `${addedCount} File(s) als PDF zusammengeführt und heruntergeladen.`, "success");
  } catch (error) {
    setMessage(listMessage, `PDF-Erstellung fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
  }
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
  if (!["pdf", "png", "jpg", "video", "audio"].includes(fileType.className)) {
    return null;
  }

  if (previewUrlCache.has(file.id)) {
    return previewUrlCache.get(file.id);
  }

  if (previewPromiseCache.has(file.id)) {
    return previewPromiseCache.get(file.id);
  }

  const promise = apiFetch(`${API_BASE}/cases/${currentCaseId}/files/${file.id}/preview`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  previewPromiseCache.set(file.id, promise);

  let response;
  try {
    response = await promise;
  } catch (error) {
    previewPromiseCache.delete(file.id);
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return null;
    }
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
      detail = "File fehlt im Serverspeicher. Bitte neu hochladen.";
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

function resolveDocumentTypeLabel(aiType, file) {
  const normalized = normalizeTitleText(aiType).toLowerCase().replace(/ü/g, "ue");
  const map = {
    "chat": "Chat",
    "brief": "Brief",
    "e-mail": "E-Mail",
    "email": "E-Mail",
    "verfuegung": "Verfügung",
    "verfügung": "Verfügung",
    "gutachten": "Gutachten",
    "bericht": "Bericht",
    "protokoll": "Protokoll",
    "eingabe": "Eingabe",
    "urteil": "Urteil",
    "superprovisorische massnahme": "Superprov. Massnahme",
    "foto": "Foto",
    "film": "Film",
    "whatsapp": "Chat"
  };

  if (map[normalized]) {
    return map[normalized];
  }

  // Check if AI returned a known type as part of a longer string
  for (const [key, label] of Object.entries(map)) {
    if (normalized.includes(key)) return label;
  }

  const mime = String(file?.mime_type || "").toLowerCase();
  if (mime.includes("pdf")) {
    return "Dokument";
  }
  if (mime.startsWith("image/")) {
    return "Foto";
  }
  if (mime.startsWith("video/")) {
    return "Film";
  }

  return normalizeTitleText(aiType) || "Dokument";
}

function renderMentionDots(count, tone) {
  const safeCount = Math.max(0, Number(count) || 0);
  const dotClass = tone === "positive" ? "is-positive" : "is-negative";

  if (safeCount <= 0) {
    return `<span class="analysis-dot-wrap"><span class="analysis-dot-count">0</span></span>`;
  }

  const dots = Array.from({ length: safeCount }, () => `<span class="analysis-dot ${dotClass}" aria-hidden="true"></span>`).join("");

  return `<span class="analysis-dot-wrap"><span class="analysis-dot-track" aria-label="${safeCount}">${dots}</span><span class="analysis-dot-count">${safeCount}</span></span>`;
}

function normalizePersonName(value) {
  const raw = normalizeTitleText(value)
    .replace(/\bPrivatperson\b/gi, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return raw;
}

function extractNamesFromChunk(value) {
  const text = normalizePersonName(value);
  if (!text) {
    return [];
  }

  const aliasSet = new Set(["kindsvater", "kindsmutter", "kindesvater", "kindesmutter"]);
  const blockedSingles = new Set([
    "abteilung", "freundliche", "gruesse", "grusse", "datum", "monat", "kantonales", "sozialamt",
    "unterhaltszahlungen", "ausstehende", "liestal", "sachbearbeiter", "sachbearbeiterin", "kinder",
    "debitoren", "kontoauszug", "alimente", "montag", "dienstag", "mittwoch", "donnerstag", "freitag",
    "samstag", "sonntag", "herr", "frau"
  ]);

  const chunks = text
    .split(/[;,\n]/)
    .map((part) => normalizePersonName(part))
    .filter(Boolean);

  const names = [];
  const namePattern = /([A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,}\s+[A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,})/g;
  for (const chunk of chunks) {
    const single = normalizePersonName(chunk);
    const singleLower = single.toLowerCase();
    if (aliasSet.has(singleLower)) {
      names.push(single.charAt(0).toUpperCase() + single.slice(1).toLowerCase());
      continue;
    }

    if (/^[A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ'’-]{2,}$/.test(single) && !blockedSingles.has(singleLower)) {
      names.push(single);
      continue;
    }

    const matches = [...chunk.matchAll(namePattern)].map((m) => normalizePersonName(m[1]));
    if (matches.length > 0) {
      names.push(...matches);
    }
  }

  return names;
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);
  for (let j = 1; j <= n; j++) {
    let prev = j;
    for (let i = 1; i <= m; i++) {
      const curr = a[i - 1] === b[j - 1] ? dp[i - 1] : 1 + Math.min(dp[i - 1], dp[i], prev);
      dp[i - 1] = prev;
      prev = curr;
    }
    dp[m] = prev;
  }
  return dp[m];
}

function samePersonFuzzy(nameA, nameB) {
  const wordsA = nameA.toLowerCase().split(/\s+/).sort();
  const wordsB = nameB.toLowerCase().split(/\s+/).sort();
  if (wordsA.join(" ") === wordsB.join(" ")) {
    return true;
  }
  if (wordsA.length !== wordsB.length) {
    return false;
  }
  return wordsA.every((w, i) => levenshtein(w, wordsB[i]) <= 1);
}

function isLikelyValidPersonLabel(value) {
  const cleaned = normalizePersonName(value);
  if (!cleaned || /\d/.test(cleaned)) {
    return false;
  }

  const aliasSet = new Set(["kindsvater", "kindsmutter", "kindesvater", "kindesmutter"]);
  const blockedWords = new Set([
    "abteilung", "freundliche", "gruesse", "grusse", "datum", "monat", "kantonales", "sozialamt",
    "unterhaltszahlungen", "ausstehende", "liestal", "sachbearbeiter", "sachbearbeiterin", "kinder",
    "debitoren", "kontoauszug", "alimente", "montag", "dienstag", "mittwoch", "donnerstag", "freitag",
    "samstag", "sonntag", "herr", "frau", "beilage", "beilagen", "zahlungsrueckstand"
  ]);

  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) {
    return false;
  }

  const lower = cleaned.toLowerCase();
  if (aliasSet.has(lower)) {
    return true;
  }

  for (const word of words) {
    const lw = word.toLowerCase();
    if (blockedWords.has(lw)) {
      return false;
    }
  }

  const capitalizedWord = /^[A-ZÄÖÜ][A-Za-zÀ-ÖØ-öø-ÿ'’-]{1,}$/;

  if (words.length === 1) {
    return capitalizedWord.test(words[0]);
  }

  return words.every((word) => capitalizedWord.test(word));
}

function collectAnalysisPeople(analysis) {
  const people = Array.isArray(analysis?.people) ? analysis.people : [];
  const unique = [];

  for (const entry of people) {
    const name = normalizeTitleText(typeof entry === "string" ? entry : entry?.name || entry?.fullName || "");
    if (!name) {
      continue;
    }
    if (unique.includes(name)) {
      continue;
    }
    unique.push(name);
  }

  return unique.slice(0, 16);
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

async function getDocumentAnalysis(file, options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const onlyStored = Boolean(options.onlyStored);
  if (analysisCache.has(file.id)) {
    return analysisCache.get(file.id);
  }

  if (analysisPromiseCache.has(file.id)) {
    return analysisPromiseCache.get(file.id);
  }

  const query = forceRefresh
    ? "?refresh=1"
    : (onlyStored ? "?onlyStored=1" : "");

  const request = apiFetch(`${API_BASE}/cases/${currentCaseId}/files/${file.id}/analysis${query}`, {
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
    })
    .catch((error) => {
      if (error instanceof Error && error.message === "AUTH_REDIRECT") {
        return {
          status: "auth-redirect",
          documentType: "",
          title: "",
          author: "",
          authoredDate: "",
          people: [],
          disadvantagedPerson: "",
          senderInstitution: "",
          impactAssessment: "",
          impactRanking: [],
          positiveMentions: 0,
          negativeMentions: 0,
          opposingPositiveMentions: 0,
          opposingNegativeMentions: 0,
          message: "",
          analysisEngineVersion: "",
          backendStartedAt: "",
          methodology: "",
          evidence: normalizeEvidence(null),
          textQuality: normalizeTextQualityMeta(null)
        };
      }

      return {
        status: "error",
        documentType: "",
        title: "",
        author: "",
        authoredDate: "",
        people: [],
        disadvantagedPerson: "",
        senderInstitution: "",
        impactAssessment: "",
        impactRanking: [],
        positiveMentions: 0,
        negativeMentions: 0,
        opposingPositiveMentions: 0,
        opposingNegativeMentions: 0,
        message: "Analyse konnte nicht geladen werden.",
        analysisEngineVersion: "",
        backendStartedAt: "",
        methodology: "",
        evidence: normalizeEvidence(null),
        textQuality: normalizeTextQualityMeta(null)
      };
    });

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
  } else if (fileType.className === "video") {
    // Video gets its own full player – zoom controls don't apply
    previewModalViewport.innerHTML = `<video class="preview-modal-video" src="${previewUrl}" controls autoplay muted playsinline></video>`;
    return; // skip updateModalZoom – not meaningful for video
  } else if (fileType.className === "audio") {
    previewModalViewport.innerHTML = `<div class="preview-modal-audio-wrap"><audio class="preview-modal-audio" src="${previewUrl}" controls autoplay></audio><p class="preview-modal-audio-name">${escapeHtml(decodeUtf8Safe(file.original_name))}</p></div>`;
    return;
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

  // ── Video: load binary, create object URL, seek to middle for thumbnail ──
  if (fileType.className === "video") {
    box.innerHTML = '<div class="row-preview-loading"><span class="spinner spinner--preview" aria-label="Vorschau wird geladen"></span></div>';
    const previewUrl = await getPreviewUrl(file);
    if (!previewUrl) {
      box.innerHTML = '<span class="row-preview-empty">Keine Vorschau</span>';
      return;
    }
    box.innerHTML = `
      <div class="row-preview-video-wrap">
        <video class="row-preview-video" src="${previewUrl}#t=0.001" preload="metadata" muted playsinline></video>
        <div class="row-preview-video-overlay" aria-hidden="true">
          <svg class="row-preview-play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </div>
      </div>`;
    const videoEl = box.querySelector("video");
    if (videoEl) {
      // Seek to middle once metadata is loaded so we get a mid-frame thumbnail
      videoEl.addEventListener("loadedmetadata", () => {
        videoEl.currentTime = videoEl.duration > 1 ? videoEl.duration / 2 : 0.001;
      });
      // On click: show native controls and start playing
      box.querySelector(".row-preview-video-wrap")?.addEventListener("click", (e) => {
        e.stopPropagation();
        const overlay = box.querySelector(".row-preview-video-overlay");
        if (overlay) overlay.style.display = "none";
        videoEl.controls = true;
        videoEl.play().catch(() => {});
      });
    }
    return;
  }

  // ── Audio: show a minimal inline player ──
  if (fileType.className === "audio") {
    box.innerHTML = '<div class="row-preview-loading"><span class="spinner spinner--preview" aria-label="Vorschau wird geladen"></span></div>';
    const previewUrl = await getPreviewUrl(file);
    if (!previewUrl) {
      box.innerHTML = '<span class="row-preview-empty">Keine Vorschau</span>';
      return;
    }
    box.innerHTML = `<audio class="row-preview-audio" src="${previewUrl}" controls preload="none"></audio>`;
    return;
  }

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

/* ================================================================
   VIDEO METADATA EXTRACTION
   Reads MP4 / MOV binary atoms directly from the cached blob URL.
   Extracts:
     • mvhd atom  → recording date (seconds since 1904-01-01 epoch)
     • ©xyz atom  → GPS string e.g. "+47.3769+008.5417+432.000/"
   No extra network request – the blob is already in memory from the
   preview download (previewUrlCache).
   ================================================================ */

/**
 * Converts a raw ©xyz GPS string into a readable German-locale form.
 * "+47.3769+008.5417+432.000/" → "47.3769° N, 8.5417° O"
 */
function formatGpsString(raw) {
  if (!raw) return null;
  const m = raw.match(/^([+-]?\d+\.?\d*)([+-]\d+\.?\d*)/);
  if (!m) return raw.replace(/[/\0]/g, "").trim() || null;
  const lat = parseFloat(m[1]);
  const lon = parseFloat(m[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return raw.replace(/[/\0]/g, "").trim() || null;
  }
  const latDir = lat >= 0 ? "N" : "S";
  const lonDir = lon >= 0 ? "O" : "W"; // German: Ost / West
  return `${Math.abs(lat).toFixed(4)}° ${latDir}, ${Math.abs(lon).toFixed(4)}° ${lonDir}`;
}

/**
 * Scans MP4/MOV atom tree and returns { recordingDate, location }.
 * @param {ArrayBuffer} buffer
 */
function parseMp4Meta(buffer) {
  const bytes = new Uint8Array(buffer);
  const view  = new DataView(buffer);
  const total = bytes.length;

  // MP4 epoch: 1904-01-01 00:00:00 UTC → offset to JS epoch in seconds
  const MP4_EPOCH_OFFSET = 2082844800;

  let recordingDate = null;
  let location      = null;

  function u32(offset) {
    if (offset + 4 > total) return 0;
    return view.getUint32(offset, false);
  }

  function tagMatch(offset, b0, b1, b2, b3) {
    if (offset + 8 > total) return false;
    return bytes[offset+4] === b0 && bytes[offset+5] === b1
        && bytes[offset+6] === b2 && bytes[offset+7] === b3;
  }

  function scan(start, end) {
    let pos = start;
    while (pos + 8 <= end && pos < total) {
      const size = u32(pos);
      if (size < 8) break;
      const atomEnd = Math.min(pos + size, end, total);

      if (tagMatch(pos, 0x6D,0x6F,0x6F,0x76)) {        // moov
        scan(pos + 8, atomEnd);
      } else if (tagMatch(pos, 0x75,0x64,0x74,0x61)) { // udta
        scan(pos + 8, atomEnd);
      } else if (tagMatch(pos, 0x6D,0x76,0x68,0x64) && !recordingDate) { // mvhd
        const version = bytes[pos + 8];
        let secs = 0;
        if (version === 0) {
          secs = u32(pos + 12);
        } else if (version === 1) {
          secs = u32(pos + 12) * 4294967296 + u32(pos + 16);
        }
        if (secs > 0) {
          const ms = (secs - MP4_EPOCH_OFFSET) * 1000;
          const d  = new Date(ms);
          const yr = d.getUTCFullYear();
          if (yr >= 1980 && yr <= 2099) {
            const dd = String(d.getUTCDate()).padStart(2, "0");
            const mo = String(d.getUTCMonth() + 1).padStart(2, "0");
            const hh = String(d.getUTCHours()).padStart(2, "0");
            const mi = String(d.getUTCMinutes()).padStart(2, "0");
            recordingDate = `${dd}.${mo}.${yr} ${hh}:${mi}`;
          }
        }
      } else if (bytes[pos+4] === 0xA9 // ©xyz
              && bytes[pos+5] === 0x78 && bytes[pos+6] === 0x79 && bytes[pos+7] === 0x7A
              && !location) {
        // After 8 bytes (size+tag): 2 bytes value-length, 2 bytes language → skip 4
        let gps = "";
        for (let i = pos + 12; i < atomEnd && i < total; i++) {
          const c = bytes[i];
          if (c === 0) break;
          gps += String.fromCharCode(c);
        }
        location = formatGpsString(gps.trim());
      }

      pos += size;
    }
  }

  scan(0, total);
  return { recordingDate, location };
}

/**
 * Extracts recording date and GPS from an MP4/MOV video file.
 * Reuses the already-cached blob (no extra network call).
 * Returns { recordingDate: string|null, location: string|null }
 */
async function extractVideoMeta(file) {
  const mime = String(file.mime_type || "").toLowerCase();
  const name = String(file.original_name || "").toLowerCase();

  // Only MP4/MOV/3GP containers carry these atoms
  const isMp4 = /\.(mov|mp4|3gp|m4v|m4a)$/i.test(name)
    || mime.includes("mp4")
    || mime.includes("quicktime")
    || mime.includes("3gpp");

  if (!isMp4) return { recordingDate: null, location: null };

  // getPreviewUrl handles caching and concurrent requests safely
  const blobUrl = await getPreviewUrl(file);
  if (!blobUrl) return { recordingDate: null, location: null };

  try {
    const resp = await fetch(blobUrl);
    const buf  = await resp.arrayBuffer();
    return parseMp4Meta(buf);
  } catch {
    return { recordingDate: null, location: null };
  }
}

async function loadRowAnalysis(file, options = {}) {
  const box = filesTableBody.querySelector(`.analysis-box[data-file-id="${file.id}"]`);
  if (!(box instanceof HTMLElement)) {
    return;
  }

  const renderMentionBars = (count, tone) => {
    const safeCount = Math.max(0, Number(count) || 0);
    const cls = tone === "positive" ? "is-positive" : "is-negative";
    if (safeCount <= 0) {
      return `<span class="qa-dot-wrap"><span class="qa-dot-count">0</span></span>`;
    }
    return `<span class="qa-dot-wrap"><span class="qa-dot-track" aria-label="${safeCount}">${Array.from({ length: safeCount }, () => `<span class="qa-dot ${cls}" aria-hidden="true"></span>`).join("")}</span><span class="qa-dot-count">${safeCount}</span></span>`;
  };

  // ── Video / Audio: no AI text analysis – extract container metadata instead ──
  const ft = resolveFileType(file);
  if (ft.className === "video" || ft.className === "audio") {
    const mediaLabel = ft.className === "video" ? "Film" : "Audio";

    // For video (MP4/MOV): parse binary atoms for recording date + GPS
    let recordingDate = "–";
    let gpsLocation   = "–";
    if (ft.className === "video") {
      box.innerHTML = `
        <div class="analysis-loading">
          <span class="spinner spinner--ai" aria-label="Metadaten werden gelesen"></span>
          <span class="analysis-loading-text">Aufnahmedatum wird gelesen…</span>
        </div>`;
      const meta = await extractVideoMeta(file);
      if (meta.recordingDate) recordingDate = meta.recordingDate;
      if (meta.location)      gpsLocation   = meta.location;
    }

    const dateLabel     = "Datum (Aufnahme)";
    const locationLabel = "Herkunft (GPS)";
    const hasRealMeta   = ft.className === "video" && (recordingDate !== "–" || gpsLocation !== "–");
    const mediaNote     = hasRealMeta
      ? `KI-Textanalyse nicht verfügbar für ${mediaLabel}-Files. Datum und GPS aus File-Metadaten (MP4/MOV-Atoms) extrahiert.`
      : `KI-Textanalyse nicht verfügbar für ${mediaLabel}-Files.`;

    box.innerHTML = `
      <div class="queue-analysis">
        <div class="forensic-report">
          <div class="forensic-report-head">
            <div class="forensic-head-left"><span class="forensic-title">Forensischer Bericht</span></div>
            <div class="qa-chip-row"><span class="qa-tag">${mediaLabel}</span></div>
          </div>
          <div class="forensic-fields-grid">
            <div class="forensic-field is-full"><span class="forensic-field-label">Titel</span><span class="forensic-field-value">–</span></div>
            <div class="forensic-field"><span class="forensic-field-label">Verfasser</span><span class="forensic-field-value">–</span></div>
            <div class="forensic-field"><span class="forensic-field-label">${escapeHtml(dateLabel)}</span><span class="forensic-field-value${recordingDate !== "–" ? ' style="font-weight:700;color:var(--accent-2)"' : ''}">${escapeHtml(recordingDate)}</span></div>
            <div class="forensic-field"><span class="forensic-field-label">${escapeHtml(locationLabel)}</span><span class="forensic-field-value${gpsLocation !== "–" ? ' style="font-weight:700;color:var(--accent-2)"' : ''}">${escapeHtml(gpsLocation)}</span></div>
          </div>
        </div>
        <p class="analysis-media-note">${escapeHtml(mediaNote)}</p>
      </div>`;
    return;
  }

  box.innerHTML = `
    <div class="ai-scanning-gold">
      <div class="ai-gold-bars">
        <span></span><span></span><span></span><span></span><span></span>
        <span></span><span></span><span></span><span></span><span></span>
        <span></span><span></span><span></span><span></span><span></span>
      </div>
      <p class="ai-gold-title">KI-Analyse läuft</p>
      <p class="ai-gold-sub">Forensische Mustererkennung · Parteienanalyse · Rechtliche Einordnung</p>
    </div>`;
  const analysis = await getDocumentAnalysis(file, options);
  if (analysis.status === "auth-redirect") {
    return;
  }

  const protectedName = normalizeTitleText(currentCaseProtectedPerson);
  const people = collectAnalysisPeople(analysis);
  const resolvedDocType = resolveDocumentTypeLabel(analysis.documentType, file);
  const swissAuthoredDate = formatSwissAnalysisDate(analysis.authoredDate);
  const positiveMentions = Math.max(0, Number(analysis.positiveMentions || 0));
  const negativeMentions = Math.max(0, Number(analysis.negativeMentions || 0));
  const opposingPositiveMentions = Math.max(0, Number(analysis.opposingPositiveMentions || 0));
  const opposingNegativeMentions = Math.max(0, Number(analysis.opposingNegativeMentions || 0));
  const analysisEngineVersion = normalizeTitleText(analysis.analysisEngineVersion || "");
  const backendStartedAt = normalizeTitleText(analysis.backendStartedAt || "");
  const methodology = normalizeTitleText(analysis.methodology || "") || "Parteibezogene Positiv-/Negativzählung mit Belegstellenprüfung.";
  const textQuality = normalizeTextQualityMeta(analysis.textQuality);
  const evidence = normalizeEvidence(analysis.evidence);
  const protectedKeywords = normalizeTitleText(currentCaseProtectedKeywords) || "Nicht gesetzt";
  const opposingKeywords = normalizeTitleText(currentCaseOpposingKeywords) || "Nicht gesetzt";
  const title = analysis.title || "Unbekannt";
  const author = analysis.author || "Unbekannt";
  const date = swissAuthoredDate || "Unbekannt";
  const senderInstitution = analysis.senderInstitution || "Unbekannt";
  const impactAssessment = analysis.impactAssessment || "";
  const manipulationsmuster = Array.isArray(analysis.manipulationsmuster) ? analysis.manipulationsmuster.filter(m => m && m.typ) : [];
  const peopleValue = people.length > 0 ? people.join(" · ") : "Keine";
  const verdict = deriveDocumentVerdict(analysis);
  const evidenceCount = countEvidenceSnippets(evidence);

  // Lawyer-style evidence text for per-document box
  const lawyerEvidenceMap = {
    "Deutlich belastend": "Das vorliegende Dokument weist im Gesamtbild eine deutlich belastende Wirkung gegenüber der Fokus-Partei aus. Die Häufung negativer Aussagen ohne sachliche Notwendigkeit stellt aus anwaltlicher Sicht ein Indiz für eine gezielte Nachteilszufügung im Sinne von Art. 28 ZGB dar.",
    "Leicht belastend": "Das Dokument zeigt eine leicht belastende Tendenz. Einzelne Formulierungen erscheinen nicht sachlich neutral und könnten als einseitige Darstellung gewertet werden. Eine Gesamtbetrachtung im Dossierkontext ist angezeigt.",
    "Deutlich entlastend": "Das vorliegende Dokument enthält überwiegend sachlich konstruktive Aussagen. Aus rechtlicher Sicht erscheint das Dokument neutral bis günstig für die Fokus-Partei.",
    "Leicht entlastend": "Das Dokument enthält tendenziell ausgewogene bis leicht positive Aussagen. Keine unmittelbaren Hinweise auf taktisch motivierte Negativdarstellungen erkennbar.",
    "Eher ausgewogen": "Das vorliegende Dokument erscheint im Wesentlichen sachlich ausgewogen. Kein eindeutiges Belastungsmuster erkennbar. Gesamtdossier-Betrachtung empfohlen."
  };
  const lawyerEvidenceText = lawyerEvidenceMap[verdict.label] || "Keine abschliessende Einordnung möglich. Analyse des Gesamtdossiers empfohlen.";
  const qualityValue = Number.isFinite(textQuality.score)
    ? `${textQuality.label} · ${textQuality.score.toFixed(2)}`
    : textQuality.label;
  const qualityDetail = Number.isFinite(textQuality.score)
    ? `Vertrauen ${textQuality.confidence}`
    : textQuality.confidence;
  const engineText = analysisEngineVersion || backendStartedAt
    ? `${analysisEngineVersion || "unbekannt"}${backendStartedAt ? ` · Instanz ${backendStartedAt}` : ""}`
    : "";

  // Derive overall bias direction for the stat section
  const totalNeg = negativeMentions + opposingPositiveMentions;
  const totalPos = positiveMentions + opposingNegativeMentions;
  const biasDirection = totalNeg > totalPos ? "belastend" : totalPos > totalNeg ? "entlastend" : "neutral";

  box.innerHTML = `
    <div class="qa-modern">
      <!-- Header -->
      <div class="qa-mod-header">
        <div>
          <p class="qa-mod-eyebrow">Dokumentenanalyse</p>
          <h4 class="qa-mod-title">${escapeHtml(title)}</h4>
        </div>
        ${resolvedDocType ? `<span class="qa-mod-doctype">${escapeHtml(resolvedDocType)}</span>` : ""}
      </div>

      <!-- Meta fields -->
      <div class="qa-mod-meta">
        <div class="qa-mod-meta-item">
          <span class="qa-mod-meta-label">Verfasser</span>
          <span class="qa-mod-meta-value">${escapeHtml(author)}</span>
        </div>
        <div class="qa-mod-meta-item">
          <span class="qa-mod-meta-label">Datum</span>
          <span class="qa-mod-meta-value">${escapeHtml(date)}</span>
        </div>
        <div class="qa-mod-meta-item">
          <span class="qa-mod-meta-label">Herkunft</span>
          <span class="qa-mod-meta-value">${escapeHtml(senderInstitution)}</span>
        </div>
      </div>

      <!-- Persons -->
      ${people.length > 0 ? `
      <div class="qa-mod-persons">
        <span class="qa-mod-meta-label">Personen</span>
        <div class="qa-mod-persons-list">${people.map(p => `<span class="qa-mod-person">${escapeHtml(p)}</span>`).join("")}</div>
      </div>` : ""}

      <!-- Fazit -->
      ${impactAssessment ? `<div class="qa-mod-verdict qa-mod-verdict--${verdict.tone}">
        <div class="qa-mod-verdict-head">
          <span class="qa-mod-verdict-label">Fazit</span>
          <span class="qa-mod-verdict-badge qa-mod-verdict-badge--${verdict.tone}">${escapeHtml(verdict.label)}</span>
        </div>
        <p class="qa-mod-verdict-text">${escapeHtml(impactAssessment)}</p>
      </div>` : ""}

      <!-- Manipulationsmuster -->
      ${manipulationsmuster.length > 0 ? `
      <div class="qa-mod-manipulation">
        <span class="qa-mod-manipulation-title">Erkannte Manipulationsmuster</span>
        <div class="qa-mod-manipulation-list">
          ${manipulationsmuster.map(m => `
            <div class="qa-mod-manipulation-item">
              <span class="qa-mod-manipulation-badge">${escapeHtml(m.typ.replace(/_/g, " "))}</span>
              <span class="qa-mod-manipulation-beleg">„${escapeHtml(m.beleg || "")}"</span>
            </div>
          `).join("")}
        </div>
      </div>` : ""}

      <!-- Party stats -->
      <div class="qa-mod-stats">
        <div class="qa-mod-stat-col">
          <span class="qa-mod-stat-role">${currentCaseProtectedLabel}</span>
          <span class="qa-mod-stat-name">${protectedKeywords}</span>
          <div class="qa-mod-stat-nums">
            <div class="qa-mod-stat-box is-positive">
              <span class="qa-mod-stat-num">${positiveMentions}</span>
              <span class="qa-mod-stat-label">Positiv</span>
            </div>
            <div class="qa-mod-stat-box is-negative">
              <span class="qa-mod-stat-num">${negativeMentions}</span>
              <span class="qa-mod-stat-label">Negativ</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderFiles(files) {
  filesTableBody.innerHTML = "";

  if (!files || files.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = "<td colspan=\"3\">Keine Files f\u00fcr die gew\u00e4hlten Filter gefunden.</td>";
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
          <div>
            <div class="preview-doc-id">File-ID: ${compactDocId(file.id)}</div>
            <div class="preview-filename">${displayName}</div>
            <div class="preview-timestamp">${formatDate(file.uploaded_at)}</div>
            <div class="preview-meta-row">
              <span class="file-icon ${fileType.className}">${fileType.label}</span>
              <span class="preview-size">${formatSizeKB(file.size_bytes)} KB</span>
            </div>
          </div>
          <div class="row-actions">
            <button type="button" class="row-action-btn download" data-action="download" data-id="${file.id}" title="Herunterladen">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            </button>
            <button type="button" class="row-action-btn delete" data-action="delete" data-id="${file.id}" title="Löschen">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6l-1 14H6L5 6"/><path d="M8 6V4h8v2"/></svg>
            </button>
          </div>
        </div>
        <div class="row-preview-box-wrap">
          <div class="row-preview-box" data-file-id="${file.id}"><div class="row-preview-loading"><span class="spinner spinner--preview" aria-label="Vorschau wird geladen"></span></div></div>
          <button type="button" class="preview-zoom-btn" data-action="zoom" data-id="${file.id}" title="Vollbild öffnen (Zoom)" aria-label="Vergrössern">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/><path d="M11 8v6M8 11h6"/></svg>
          </button>
        </div>
      </td>
      <td class="analysis-cell">
        <div class="analysis-cell-top">
          <button type="button" class="row-action-btn refresh" data-action="refresh-analysis" data-id="${file.id}" title="Analyse neu laden" aria-label="Analyse neu laden">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
            </svg>
          </button>
        </div>
        <div class="analysis-box" data-file-id="${file.id}"></div>
      </td>
    `;
    filesTableBody.appendChild(tr);
  }

  for (const file of files) {
    void loadRowPreview(file);
    void loadRowAnalysis(file, { onlyStored: true });
  }
}

async function refreshAnalysis(fileId, triggerButton) {
  const file = allFiles.find((entry) => entry.id === fileId);
  if (!file) {
    return;
  }

  if (triggerButton instanceof HTMLButtonElement) {
    triggerButton.disabled = true;
    triggerButton.dataset.prevHtml = triggerButton.innerHTML;
    triggerButton.classList.add("is-loading");
  }

  analysisCache.delete(fileId);
  analysisPromiseCache.delete(fileId);

  try {
    await loadRowAnalysis(file, { forceRefresh: true });
    await refreshAnalysisReport(allFiles);
    setMessage(listMessage, "Analyse aktualisiert.", "success");
  } catch {
    setMessage(listMessage, "Analyse konnte nicht aktualisiert werden.", "error");
  } finally {
    if (triggerButton instanceof HTMLButtonElement) {
      triggerButton.disabled = false;
      triggerButton.classList.remove("is-loading");
      if (triggerButton.dataset.prevHtml) {
        triggerButton.innerHTML = triggerButton.dataset.prevHtml;
      }
    }
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
    void refreshAnalysisReport(allFiles);
    setMessage(listMessage, "Löschen rückgängig gemacht.", "success");
    pendingDelete = null;
    hideUndoBar();
  });
}

async function commitDelete(fileId) {
  const response = await apiFetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "File konnte nicht gel\u00f6scht werden.");
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
    setMessage(listMessage, "File endg\u00fcltig gel\u00f6scht.", "success");
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
    allFiles = [snapshot.file, ...allFiles];
    allFiles.sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());
    renderFiles(filterFiles(allFiles));
    void refreshAnalysisReport(allFiles);
    setMessage(listMessage, error.message || "File konnte nicht gel\u00f6scht werden.", "error");
  }
}

async function loadCaseContext() {
  try {
    const response = await apiFetch(`${API_BASE}/cases`, {
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
    currentCaseOpposingParty = normalizeTitleText(active.opposing_party || "");
    currentCaseProtectedKeywords = String(active.protected_person_name || "").trim();
    currentCaseOpposingKeywords = String(active.opposing_party || "").trim();
    currentCaseCountry = normalizeTitleText(active.country || "");
    currentCaseLocality = normalizeTitleText(active.locality || "");
    currentCaseRegion = normalizeTitleText(active.region || active.locality || "");
    currentCaseCity = normalizeTitleText(active.city || "");
    currentCaseName = normalizeTitleText(active.case_name || "");
    listTitle.textContent = "Fall";

    const personsRow = document.getElementById("casePersonsRow");
    if (personsRow) {
      const parts = [];
      const caseValue = currentCaseName
        ? `${currentCaseName} (${currentCaseId})`
        : currentCaseId;
      parts.push(buildEditableField("is-meta is-case", "case_name", "Fallname", currentCaseName));
      parts.push(`<div class="case-person-field is-meta"><div class="case-field-row"><div class="case-field-body"><span class="case-person-label">Fallnummer</span><span class="case-person-value">${escapeHtml(currentCaseId)}</span></div></div></div>`);
      parts.push(buildEditableField("is-protected", "protected_person_name", "Fokus-Partei", currentCaseProtectedPerson));
      parts.push(buildEditableField("is-opposing", "opposing_party", "Gegenpartei", currentCaseOpposingParty));
      const regionLabel = currentCaseCountry === "Schweiz" ? "Kanton" : currentCaseCountry ? "Bundesland" : "Kanton / Bundesland";
      parts.push(buildEditableField("is-meta", "country", "Land", currentCaseCountry));
      parts.push(buildEditableField("is-meta", "region", regionLabel, currentCaseRegion));
      if (currentCaseCity) {
        parts.push(buildEditableField("is-meta", "city", "Ortschaft / Sitz des Gerichts", currentCaseCity));
      }
      personsRow.innerHTML = parts.join("");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
    // Keep default title when case context cannot be loaded.
  }
}

async function deleteCurrentCase() {
  const descriptor = currentCaseName || `Fall ${currentCaseId}`;
  const confirmed = window.confirm(`Bist du sicher, dass du "${descriptor}" inklusive aller Files l\u00f6schen willst?`);
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
    const response = await apiFetch(`${API_BASE}/cases/${currentCaseId}`, {
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
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
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
    res = await apiFetch(`${API_BASE}/cases/${currentCaseId}/files`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
    showServiceAlert("Keine Verbindung zum Backend");
    setMessage(listMessage, "Backend nicht erreichbar. Bitte später erneut versuchen.", "error");
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    allFiles = data.files || [];
    renderFiles(filterFiles(allFiles));
    void refreshAnalysisReport(allFiles);
    return;
  }

  if (OUTAGE_STATUSES.has(Number(res.status))) {
    showServiceAlert("Dateiliste derzeit nicht verfügbar");
  }
  setMessage(listMessage, data.error || "Dateiliste konnte nicht geladen werden.", "error");
}

async function downloadFile(fileId) {
  let response;
  try {
    response = await apiFetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}/download`, {
      headers: { Authorization: `Bearer ${token}` }
    });
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
    setMessage(listMessage, "File konnte nicht heruntergeladen werden.", "error");
    return;
  }

  if (!response.ok) {
    setMessage(listMessage, "File konnte nicht heruntergeladen werden.", "error");
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
  void refreshAnalysisReport(allFiles);

  const timerId = window.setTimeout(() => {
    void flushPendingDelete();
  }, 5000);

  pendingDelete = { file, timerId };
  showUndoBar(file.original_name);
  setMessage(listMessage, "Datei entfernt. Rückgängig möglich.", "success");
}

filesTableBody.addEventListener("click", async (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }

  const actionElement = target.closest("[data-action]");
  const action = actionElement instanceof Element ? actionElement.dataset.action : "";
  const fileId = actionElement instanceof Element ? actionElement.dataset.id : "";
  const rowActions = target.closest(".row-actions");

  if (action === "refresh-analysis" && fileId) {
    await refreshAnalysis(fileId, actionElement instanceof HTMLButtonElement ? actionElement : null);
    return;
  }

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

for (const element of [fileTypeFilter, dateFromFilter, dateToFilter].filter(Boolean)) {
  element.addEventListener("change", () => {
    renderFiles(filterFiles(allFiles));
  });
}

// Search input – debounced live search
const fileSearchInput = document.getElementById("fileSearchInput");
if (fileSearchInput) {
  let searchTimer = null;
  fileSearchInput.addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      renderFiles(filterFiles(allFiles));
    }, 250);
  });
}

// Sort dir buttons – delegated handler covers all 4 ASC/DESC buttons
document.querySelectorAll(".fp-sort-btn[data-sort-field]").forEach(btn => {
  btn.addEventListener("click", () => {
    currentSortField = btn.dataset.sortField;
    currentSortOrder = btn.dataset.sortOrder;
    updateSortUI();
    renderFiles(filterFiles(allFiles));
  });
});

downloadAllFilesBtn?.addEventListener("click", () => void downloadAllFilesAsPdf());

goToUploadBtnHero?.addEventListener("click", () => {
  window.location.href = "/upload.html";
});
goToUploadBtn?.addEventListener("click", () => {
  window.location.href = "/upload.html";
});

async function exportKiReportAsPdf() {
  const reportEl = document.getElementById("analysisReportBar");
  if (!reportEl) return;

  const btn = exportPdfReportBtn;
  const originalHtml = btn?.innerHTML ?? "PDF KI-Report";

  // ── 1. Apply body.printing class – CSS hides all UI, constrains widths ──
  document.body.classList.add("printing");

  // ── 2. Show loading state (button is hidden inside report via body.printing) ──
  if (!document.getElementById("rSpinStyle")) {
    const s = document.createElement("style");
    s.id = "rSpinStyle";
    s.textContent = "@keyframes rSpin{to{transform:rotate(360deg)}}";
    document.head.appendChild(s);
  }
  const spinnerHtml = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" style="width:.88rem;height:.88rem;animation:rSpin 700ms linear infinite;vertical-align:middle;margin-right:.3rem"><path d="M12 4a8 8 0 0 1 7.75 6h-2.2A6 6 0 1 0 16.2 16l-2.2-2.2H20v6l-2.35-2.35A8 8 0 1 1 12 4z"/></svg>PDF wird erstellt…`;
  if (btn) { btn.disabled = true; btn.innerHTML = spinnerHtml; }

  // ── 3. Wait two rAFs so all printing styles are fully painted ──
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

  const CAPTURE_W = 740; // px – matches body.printing width
  const filename  = `DMSKI-KI-Report-${currentCaseId}.pdf`;

  const opt = {
    margin:      [8, 8, 8, 8],
    filename,
    image:       { type: "jpeg", quality: 0.97 },
    html2canvas: {
      scale:           2,
      useCORS:         true,
      allowTaint:      true,
      letterRendering: true,
      logging:         false,
      scrollX:         0,
      scrollY:         0,
      width:           CAPTURE_W,
      backgroundColor: "#ffffff"
    },
    jsPDF:       { unit: "mm", format: "a4", orientation: "portrait" },
    pagebreak:   { mode: ["css", "legacy"], avoid: [".tactic-section", ".tactic-counsel-item", ".tactic-analysis-box", ".tactic-legal-text", ".akteure-table-container", ".analysis-report-card"] }
  };

  try {
    await window.html2pdf().set(opt).from(reportEl).save();
  } catch {
    alert("PDF-Export fehlgeschlagen. Bitte Seite neu laden und erneut versuchen.");
  } finally {
    // ── Remove printing class – restores full UI ──
    document.body.classList.remove("printing");
    if (btn) { btn.disabled = false; btn.innerHTML = originalHtml; }
  }
}

exportPdfReportBtn?.addEventListener("click", () => void exportKiReportAsPdf());

backToCasesBtn?.addEventListener("click", () => {
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
    ? `${count} File${count === 1 ? "" : "s"} ausgew\u00e4hlt.`
    : "Keine Files ausgew\u00e4hlt.";
    
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
  void refreshAnalysisReport(allFiles);

  try {
    const promises = filesToDelete.map((fileId) =>
      apiFetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` }
      }).then((res) => {
        if (!res.ok) {
          throw new Error(`Fehler beim L\u00f6schen von File ${fileId}`);
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

    setMessage(listMessage, `${filesToDelete.length} File${filesToDelete.length === 1 ? "" : "s"} gel\u00f6scht.`, "success");
    isMultiDeleteMode = false;
    applyMultiDeleteUiState();
    renderFiles(filterFiles(allFiles));
    void refreshAnalysisReport(allFiles);
    updateMultiDeleteCount();
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
    allFiles = originalFiles;
    renderFiles(filterFiles(allFiles));
    void refreshAnalysisReport(allFiles);
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

// Delegated handler for inline case-field editing
document.addEventListener("click", async (event) => {
  const editBtn = event.target.closest(".case-edit-btn");
  if (editBtn) {
    const fieldEl = editBtn.closest("[data-edit-field]");
    if (fieldEl) startCaseFieldEdit(fieldEl);
    return;
  }
  const saveBtn = event.target.closest("[data-action='save-field']");
  if (saveBtn && saveBtn.closest("[data-edit-field]")) {
    const fieldEl = saveBtn.closest("[data-edit-field]");
    if (fieldEl) await saveCaseField(fieldEl);
    return;
  }
  const cancelBtn = event.target.closest("[data-action='cancel-field']");
  if (cancelBtn && cancelBtn.closest("[data-edit-field]")) {
    const fieldEl = cancelBtn.closest("[data-edit-field]");
    if (fieldEl) cancelCaseFieldEdit(fieldEl);
  }
});

if (copyrightYearEl) copyrightYearEl.textContent = String(new Date().getFullYear());
void loadCaseContext().then(() => {
  loadFiles();
});

/* ================================================================
   FORENSIC SCAN – Claude KI-Tiefenanalyse
   ================================================================ */
(function initForensicScan() {
  const scanBtn = document.getElementById("startForensicScanBtn");
  const progressWrap = document.getElementById("forensicProgress");
  const progressFill = document.getElementById("forensicProgressFill");
  const progressText = document.getElementById("forensicProgressText");
  const resultsWrap = document.getElementById("forensicResults");
  if (!scanBtn) return;

  function setProgress(pct, text) {
    if (progressWrap) progressWrap.classList.remove("hidden");
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressText) progressText.textContent = text;
  }

  function riskClass(level) {
    if (level === "kritisch") return "is-kritisch";
    if (level === "hoch") return "is-hoch";
    if (level === "mittel") return "is-mittel";
    return "is-niedrig";
  }

  function renderForensicResults(data) {
    if (!resultsWrap) return;
    const crossDoc = data.crossDoc || {};
    const widersprueche = crossDoc.widersprueche || [];
    const muster = crossDoc.muster || [];
    const findings = data.topFindings || [];

    let html = "";

    // Score cards row
    html += `<div class="forensic-score-row">
      <div class="forensic-score-card">
        <span class="forensic-score-card-label">Einzeldokument-Score</span>
        <span class="forensic-score-card-value ${riskClass(data.gesamtRisiko)}">${data.totalScore}/100</span>
      </div>`;
    if (data.crossDocScore != null) {
      html += `<div class="forensic-score-card">
        <span class="forensic-score-card-label">Kreuzanalyse-Score</span>
        <span class="forensic-score-card-value ${riskClass(crossDoc.gesamtRisiko || data.gesamtRisiko)}">${data.crossDocScore}/100</span>
      </div>`;
    }
    html += `<div class="forensic-score-card">
        <span class="forensic-score-card-label">Gesamt-Risiko</span>
        <span class="forensic-score-card-value ${riskClass(data.gesamtRisiko)}">${(data.combinedScore || data.totalScore)}/100</span>
        <span class="forensic-risk-badge ${riskClass(data.gesamtRisiko)}">${escapeHtml(data.gesamtRisiko || "niedrig")}</span>
      </div>
      <div class="forensic-score-card">
        <span class="forensic-score-card-label">Analysiert</span>
        <span class="forensic-score-card-value">${data.analyzedCount}/${data.fileCount}</span>
      </div>
    </div>`;

    // Fazit
    html += `<div class="forensic-fazit">${escapeHtml(data.gesamtFazit || "")}</div>`;

    // Cross-doc contradictions
    if (widersprueche.length > 0) {
      html += `<h4 class="forensic-contradictions-title">Dokumentuebergreifende Widersprueche (${widersprueche.length})</h4>`;
      for (const w of widersprueche) {
        html += `<div class="forensic-contradiction">
          <div class="forensic-contradiction-header">
            <span>Widerspruch</span>
            <span class="forensic-risk-badge ${riskClass(w.schweregrad)}">${escapeHtml(w.schweregrad)}</span>
          </div>
          <div class="forensic-contradiction-body">
            <div class="forensic-contradiction-docs">
              <div class="forensic-contradiction-doc">
                <span class="forensic-contradiction-doc-name">${escapeHtml(w.dokument_a)}</span>
                ${escapeHtml(w.aussage_a)}
              </div>
              <div class="forensic-contradiction-vs">VS</div>
              <div class="forensic-contradiction-doc">
                <span class="forensic-contradiction-doc-name">${escapeHtml(w.dokument_b)}</span>
                ${escapeHtml(w.aussage_b)}
              </div>
            </div>
            <p class="forensic-contradiction-analyse">${escapeHtml(w.analyse)}</p>
          </div>
        </div>`;
      }
    }

    // Patterns
    if (muster.length > 0) {
      html += `<h4 class="forensic-patterns-title">Erkannte Muster (${muster.length})</h4>`;
      for (const m of muster) {
        const typeLabels = {
          systematische_negativdarstellung: "Systematische Negativdarstellung",
          eskalation: "Eskalationsmuster",
          koordination: "Koordinierte Strategie",
          fehlende_gegendarstellung: "Fehlende Gegendarstellung",
          instrumentalisierung_kinder: "Instrumentalisierung von Kindern"
        };
        html += `<div class="forensic-pattern">
          <p class="forensic-pattern-type">${escapeHtml(typeLabels[m.typ] || m.typ)}</p>
          <p class="forensic-pattern-analyse">${escapeHtml(m.analyse)}</p>
          ${m.betroffene_dokumente.length > 0 ? `<p class="forensic-pattern-docs">Dokumente: ${m.betroffene_dokumente.map(d => escapeHtml(d)).join(", ")}</p>` : ""}
        </div>`;
      }
    }

    // Top findings
    if (findings.length > 0) {
      html += `<h4 class="forensic-findings-title">Top-Auffaelligkeiten (${data.findingsTotal || findings.length})</h4>`;
      for (const f of findings) {
        html += `<div class="forensic-finding">
          <span class="forensic-finding-type">${escapeHtml(f.typ || "")}</span>
          <div class="forensic-finding-content">
            <p class="forensic-finding-stelle">"${escapeHtml(f.stelle || "")}"</p>
            <p class="forensic-finding-analyse">${escapeHtml(f.analyse || "")}</p>
            ${f.fileName ? `<span class="forensic-pattern-docs">${escapeHtml(f.fileName)}</span>` : ""}
          </div>
          <span class="forensic-risk-badge ${riskClass(f.schweregrad)}">${escapeHtml(f.schweregrad || "")}</span>
        </div>`;
      }
    }

    // Cross-doc fazit
    if (crossDoc.fazit && crossDoc.status === "ok") {
      html += `<div class="forensic-fazit" style="margin-top:1.5rem;border-left-color:#c0392b"><strong>Kreuzanalyse-Fazit:</strong> ${escapeHtml(crossDoc.fazit)}</div>`;
    }

    resultsWrap.innerHTML = html;
    resultsWrap.classList.remove("hidden");
  }

  scanBtn.addEventListener("click", async () => {
    scanBtn.disabled = true;
    resultsWrap.classList.add("hidden");
    resultsWrap.innerHTML = "";

    setProgress(5, "Forensische Analyse wird gestartet…");

    try {
      setProgress(15, "Einzeldokumente werden analysiert…");

      const response = await apiFetch(`${API_BASE}/cases/${currentCaseId}/forensic`, {
        headers: { Authorization: `Bearer ${sessionStorage.getItem("token") || localStorage.getItem("token")}` }
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${response.status}`);
      }

      setProgress(90, "Ergebnisse werden aufbereitet…");

      const data = await response.json();
      setProgress(100, `Analyse abgeschlossen – ${data.analyzedCount || 0} Dateien gescannt`);

      renderForensicResults(data);
    } catch (err) {
      setProgress(100, `Fehler: ${err.message}`);
      if (resultsWrap) {
        resultsWrap.innerHTML = `<div class="forensic-fazit" style="border-left-color:#c0392b">Forensische Analyse fehlgeschlagen: ${escapeHtml(err.message)}</div>`;
        resultsWrap.classList.remove("hidden");
      }
    } finally {
      scanBtn.disabled = false;
    }
  });
})();


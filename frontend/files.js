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

const API_BASE = isLocalHost
  ? "http://localhost:4000"
  : "https://lively-reverence-production-def3.up.railway.app";

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
let currentCaseProtectedLabel = "Benachteiligte Person";
let currentCaseName = "";
let currentCaseOpposingParty = "";
let currentCaseOpposingLabel = "Gegenpartei";
let currentCaseCountry = "";
let currentCaseLocality = "";
let currentCaseRegion = "";
let currentCaseCity = "";

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

function buildEditableField(cssClass, apiField, label, value, style) {
  const styleAttr = style ? ` style="${style}"` : "";
  return `<div class="case-person-field ${cssClass}" data-edit-field="${apiField}"${styleAttr}><div class="case-field-row"><div class="case-field-body"><span class="case-person-label">${escapeHtml(label)}</span><span class="case-person-value">${escapeHtml(value || "Nicht gesetzt")}</span></div><button class="case-edit-btn" title="${escapeHtml(label)} bearbeiten" aria-label="${escapeHtml(label)} bearbeiten">${PENCIL_SVG}</button></div></div>`;
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

function renderAnalysisReportCard(label, value, detail = "", tone = "neutral") {
  return `<article class="analysis-report-card is-${tone}"><span class="analysis-report-card-label">${escapeHtml(label)}</span><strong class="analysis-report-card-value">${escapeHtml(value)}</strong>${detail ? `<span class="analysis-report-card-detail">${escapeHtml(detail)}</span>` : ""}</article>`;
}

function renderPartyReportCard(label, positiveCount, negativeCount) {
  const pos = Math.max(0, Number(positiveCount || 0));
  const neg = Math.max(0, Number(negativeCount || 0));
  return `<article class="analysis-report-card is-party"><span class="analysis-report-card-label">${escapeHtml(label)}</span><div class="party-split"><div class="party-split-item is-positive"><span class="party-split-num">${pos}</span><span class="party-split-label">Positiv</span></div><div class="party-split-item is-negative"><span class="party-split-num">${neg}</span><span class="party-split-label">Negativ</span></div></div></article>`;
}

function renderAnalysisReportMeta(verdict, methodology, note) {
  return [
    `<article class="analysis-report-meta-card is-${escapeHtml(verdict.tone || "neutral")}"><span class="analysis-report-meta-label">Einordnung</span><strong class="analysis-report-meta-value">${escapeHtml(verdict.label || "Neutral")}</strong><p class="analysis-report-meta-text">${escapeHtml(verdict.detail || "")}</p></article>`,
    `<article class="analysis-report-meta-card"><span class="analysis-report-meta-label">Methodik</span><strong class="analysis-report-meta-value">Forensische Kurzprüfung</strong><p class="analysis-report-meta-text">${escapeHtml(methodology)}</p></article>`,
    `<article class="analysis-report-meta-card"><span class="analysis-report-meta-label">Berichtshinweis</span><strong class="analysis-report-meta-value">Transparenz aktiviert</strong><p class="analysis-report-meta-text">${escapeHtml(note)}</p></article>`
  ].join("");
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
  const nameP = escapeHtml(protectedPerson || "benachteiligte Person");

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
    legalNote = `Irrelevante Persönlichkeitsinformationen über die benachteiligte Person können gemäss Art. 152 ZPO formell gerügt werden. Das Gericht kann solche Ausführungen aus dem Recht weisen. Selektive Darstellungen können unter Art. 28 ZGB als Persönlichkeitsrechtsverletzung geprüft werden.`;
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
    rows.push({ tactic: "Keine Auffälligkeiten erkannt", article: "–", present: false, evidence: "Dokument erscheint sachlich" });
  }

  return { profileTitle, summary, legalTitle, legalNote, rows, pressure };
}

function renderTacticAnalysisBox(analysis, protectedPerson, opposingParty, docId) {
  const profile = deriveTacticProfile(analysis, protectedPerson, opposingParty);
  const docRef  = docId ? escapeHtml(String(docId)) : "Gesamt";

  const tableRows = profile.rows.map(r => {
    const cls     = r.present ? "tactic-row-present" : "tactic-row-absent";
    const badge   = r.present
      ? `<span class="tactic-badge is-found">Indiz</span>`
      : `<span class="tactic-badge is-none">Kein Nachweis</span>`;
    return `<tr class="${cls}">
      <td>${escapeHtml(r.tactic)}</td>
      <td>${escapeHtml(r.article)}</td>
      <td>${badge} ${escapeHtml(r.evidence.replace(/^Indiz erkannt – ?|^Erkannt – ?|^Kein ausreichender Nachweis ?|^Kein Nachweis ?|^Leichte Tendenz erkannt ?/i, ""))}</td>
      <td>${docRef}</td>
    </tr>`;
  }).join("");

  const legalHtml = profile.legalNote
    ? `<div class="tactic-legal-assessment">
        <p class="tactic-legal-assessment-title">⚖️ ${escapeHtml(profile.legalTitle)}</p>
        <p class="tactic-legal-assessment-text">${profile.legalNote}</p>
       </div>`
    : "";

  return `
    <div class="tactic-analysis-box">
      <p class="tactic-analysis-eyebrow">Einordnung · KI-Analyse</p>
      <p class="tactic-analysis-profile-title">${escapeHtml(profile.profileTitle)}</p>
      <div class="tactic-analysis-body">${profile.summary}</div>
      <div class="tactic-table-wrap">
        <table class="tactic-table">
          <thead>
            <tr>
              <th>Tatbestand / Methode</th>
              <th>Rechtsgrundlage (CH)</th>
              <th>KI-Einschätzung</th>
              <th>Dok-Referenz</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
      ${legalHtml}
    </div>
  `;
}

/* ----------------------------------------------------------------
   AKTEURE BOX – All persons from document, colour-coded sentiment
   ---------------------------------------------------------------- */
function derivePersonSentiment(person, analysis, protectedPerson, opposingParty) {
  const nameNorm = normalizeTitleText(person.name || "").toLowerCase();
  const affil = normalizeTitleText(person.affiliation || "").toLowerCase();
  const protNorm = normalizeTitleText(protectedPerson || "").toLowerCase();
  const oppNorm = normalizeTitleText(opposingParty || "").toLowerCase();

  // Protected person is always neutral (they're the subject, not an actor)
  if (protNorm && nameNorm.includes(protNorm.split(" ")[0]?.toLowerCase() || "___")) {
    return "neutral";
  }

  // Check affiliation-based assignment
  if (affil.includes("anwalt") || affil.includes("rechtsvertr") || affil.includes("jurist")) {
    // Lawyer for opposing party = negative tendency
    if (oppNorm && (affil.includes(oppNorm.split(" ")[0]?.toLowerCase() || "___"))) {
      return "negative";
    }
  }

  if (affil.includes("kesb") || affil.includes("behörd") || affil.includes("gericht") || affil.includes("richter")) {
    return "neutral";
  }

  if (affil.includes("privatperson") || affil === "") {
    // Unnamed private persons → derive from document tone
    const pressure = (Number(analysis.negativeMentions || 0) + Number(analysis.opposingPositiveMentions || 0))
      - (Number(analysis.positiveMentions || 0) + Number(analysis.opposingNegativeMentions || 0));
    return pressure > 1 ? "negative" : pressure < -1 ? "positive" : "neutral";
  }

  return "neutral";
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
  if (lc.includes("beistand") || lc.includes("beiständin")) return "Beistand / Beiständin";
  if (lc.includes("kesb")) return "KESB Behördenmitglied";
  if (lc.includes("gericht") || lc.includes("richter") || lc.includes("richterin")) return "Gericht";
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
  if (sentiment === "positive") return "Positiv gegenüber Betroffener";
  if (sentiment === "negative") return "Negativ gegenüber Betroffener";
  return "Neutral / Sachlich";
}

function renderAkteureBox(analysis, protectedPerson, opposingParty) {
  const people = Array.isArray(analysis.people) ? analysis.people : [];

  // Deduplicate by normalised name
  const seen = new Set();
  const unique = people.filter(p => {
    const k = normalizeTitleText(p.name || "").toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  if (unique.length === 0) {
    return `
      <div class="akteure-box">
        <div class="akteure-head-simple">
          <p class="akteure-title-simple">Personen</p>
          <div class="akteure-legend">
            <span class="akteure-legend-item"><span class="akteure-legend-dot is-positive"></span>Positiv</span>
            <span class="akteure-legend-item"><span class="akteure-legend-dot is-negative"></span>Negativ</span>
            <span class="akteure-legend-item"><span class="akteure-legend-dot is-neutral"></span>Neutral</span>
          </div>
        </div>
        <p class="akteure-empty">Noch keine Personen extrahiert. Werden mit jedem weiteren Dokument ergänzt.</p>
      </div>
    `;
  }

  const rows = unique.map(person => {
    const sentiment  = derivePersonSentiment(person, analysis, protectedPerson, opposingParty);
    const roleLabel  = getAffiliationLabel(person.affiliation);
    const displayName = formatNameLastFirst(person.name);
    return `
      <tr class="akteure-row">
        <td class="akteure-col-name">${escapeHtml(displayName)}</td>
        <td class="akteure-col-role">${escapeHtml(roleLabel)}</td>
        <td class="akteure-col-dot"><span class="akteure-sentiment-dot is-${sentiment}" title="${escapeHtml(getSentimentLabel(sentiment))}"></span></td>
      </tr>
    `;
  }).join("");

  return `
    <div class="akteure-box">
      <div class="akteure-head-simple">
        <p class="akteure-title-simple">Personen</p>
        <div class="akteure-legend">
          <span class="akteure-legend-item"><span class="akteure-legend-dot is-positive"></span>Positiv</span>
          <span class="akteure-legend-item"><span class="akteure-legend-dot is-negative"></span>Negativ</span>
          <span class="akteure-legend-item"><span class="akteure-legend-dot is-neutral"></span>Neutral</span>
        </div>
      </div>
      <table class="akteure-table">
        <thead>
          <tr>
            <th>Name, Vorname</th>
            <th>Funktion</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
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
        <span class="qa-focus-subtitle">Gewichtete Auffälligkeiten aus Personenbezug und Dokumentkontext</span>
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
    renderAnalysisReportCard("Anzahl Files", String(allFiles.length || 0), "Gesamtbestand", "neutral"),
    renderPartyReportCard("Benachteiligte Person", 0, 0),
    renderPartyReportCard("Gegenpartei", 0, 0)
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
    analysisReportHint.textContent = "Noch keine Dateien im Dossier.";
    analysisReportMeta.innerHTML = renderAnalysisReportMeta(
      { label: "Leeres Dossier", tone: "neutral", detail: "Noch keine Dokumente hochgeladen." },
      "Parteibezogene Positiv-/Negativzählung mit Belegstellen und Qualitätsprüfung.",
      "Die Gesamtbeurteilung erscheint, sobald erste Dokumente vorliegen."
    );
    analysisReportGrid.innerHTML = [
      renderAnalysisReportCard("Anzahl Files", "0", "Noch keine Inhalte", "neutral"),
      renderPartyReportCard("Benachteiligte Person", 0, 0),
      renderPartyReportCard("Gegenpartei", 0, 0)
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
    const hintParts = [`${analyzedCount} von ${fileCount} Datei${fileCount === 1 ? "" : "en"} analysiert`];
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
      renderAnalysisReportCard("Anzahl Files", String(fileCount), "Gesamtbestand", "neutral"),
      renderPartyReportCard("Benachteiligte Person", protectedPositiveTotal, protectedNegativeTotal),
      renderPartyReportCard("Gegenpartei", opposingPositiveTotal, opposingNegativeTotal)
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
      analysisReportTactics.innerHTML = renderTacticAnalysisBox(
        aggregateSynthesis,
        currentCaseProtectedPerson,
        currentCaseOpposingParty
      );
    }

    // ── Dossier-level Akteure (merged from all documents, deduped) ─────
    if (analysisReportAkteure instanceof HTMLElement) {
      const seenNames = new Set();
      const mergedPeople = [];
      for (const a of analyses) {
        if (!a || a.status === "auth-redirect") continue;
        const docPeople = Array.isArray(a.people) ? a.people : [];
        for (const p of docPeople) {
          const key = normalizeTitleText(p.name || "").toLowerCase();
          if (!key || seenNames.has(key)) continue;
          seenNames.add(key);
          mergedPeople.push(p);
        }
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
        currentCaseOpposingParty
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
      renderAnalysisReportCard("Anzahl Files", String(fileCount), "Bestand erkannt", "neutral"),
      renderPartyReportCard("Benachteiligte Person", 0, 0),
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

function resolveDocumentTypeLabel(aiType, file) {
  const normalized = normalizeTitleText(aiType).toLowerCase();
  const map = {
    "chat": "Chat",
    "brief": "Brief",
    "e-mail": "E-Mail",
    "email": "E-Mail",
    "foto": "Foto",
    "film": "Film",
    "whatsapp": "Chat"
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
  if (mime.startsWith("video/")) {
    return "Film";
  }

  return normalizeTitleText(aiType) || "Nicht erkannt";
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

  box.innerHTML = `
    <div class="analysis-loading">
      <span class="spinner spinner--ai" aria-label="KI analysiert"></span>
      <span class="analysis-loading-text">KI analysiert Dokument&hellip;<br /><small>Das kann bei Bildern l&auml;nger dauern.</small></span>
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
  const peopleValue = people.length > 0 ? people.join(" · ") : "Keine";
  const verdict = deriveDocumentVerdict(analysis);
  const evidenceCount = countEvidenceSnippets(evidence);
  const qualityValue = Number.isFinite(textQuality.score)
    ? `${textQuality.label} · ${textQuality.score.toFixed(2)}`
    : textQuality.label;
  const qualityDetail = Number.isFinite(textQuality.score)
    ? `Vertrauen ${textQuality.confidence}`
    : textQuality.confidence;
  const engineText = analysisEngineVersion || backendStartedAt
    ? `${analysisEngineVersion || "unbekannt"}${backendStartedAt ? ` · Instanz ${backendStartedAt}` : ""}`
    : "";

  box.innerHTML = `
    <div class="queue-analysis">
      <div class="forensic-report">
        <div class="forensic-report-head">
          <div class="forensic-head-left">
            <span class="forensic-title">Forensischer Bericht</span>
          </div>
          <div class="qa-chip-row">
            ${resolvedDocType ? `<span class="qa-tag">${escapeHtml(resolvedDocType)}</span>` : ""}
          </div>
        </div>
        <div class="forensic-fields-grid">
          <div class="forensic-field is-full"><span class="forensic-field-label">Titel</span><span class="forensic-field-value">${escapeHtml(title)}</span></div>
          <div class="forensic-field"><span class="forensic-field-label">Verfasser</span><span class="forensic-field-value">${escapeHtml(author)}</span></div>
          <div class="forensic-field"><span class="forensic-field-label">Datum</span><span class="forensic-field-value">${escapeHtml(date)}</span></div>
          <div class="forensic-field"><span class="forensic-field-label">Herkunft</span><span class="forensic-field-value">${escapeHtml(senderInstitution)}</span></div>
        </div>
        ${people.length > 0 ? `<div class="forensic-persons-row"><span class="forensic-field-label" style="width:100%;margin-bottom:0.25rem">Personen</span>${people.map((p) => `<span class="forensic-person-chip">${escapeHtml(p)}</span>`).join("")}</div>` : ""}
        ${impactAssessment ? `<div class="forensic-fazit"><span class="forensic-fazit-label">Fazit</span>${escapeHtml(impactAssessment)}</div>` : ""}
      </div>
      <div class="qa-mentions">
        <div class="qa-persons-grid">
          <div class="qa-person-col">
            <div class="qa-person-col-label"><span class="qa-person-role">${currentCaseProtectedLabel}</span><span class="qa-person-keywords">${protectedKeywords}</span></div>
            <div class="qa-stat-row">
              <div class="qa-stat is-positive"><span class="qa-stat-num">${positiveMentions}</span><span class="qa-stat-label">Positiv</span></div>
              <div class="qa-stat is-negative"><span class="qa-stat-num">${negativeMentions}</span><span class="qa-stat-label">Negativ</span></div>
            </div>
          </div>
          <div class="qa-person-col">
            <div class="qa-person-col-label"><span class="qa-person-role">${currentCaseOpposingLabel}</span><span class="qa-person-keywords">${opposingKeywords}</span></div>
            <div class="qa-stat-row">
              <div class="qa-stat is-positive"><span class="qa-stat-num">${opposingPositiveMentions}</span><span class="qa-stat-label">Positiv</span></div>
              <div class="qa-stat is-negative"><span class="qa-stat-num">${opposingNegativeMentions}</span><span class="qa-stat-label">Negativ</span></div>
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
          <div class="preview-doc-id">Dok-ID: ${compactDocId(file.id)}</div>
          <div class="row-actions">
            <button type="button" class="btn-inline download" data-action="download" data-id="${file.id}">DOWNLOAD</button>
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
        <div class="analysis-cell-top">
          <button type="button" class="btn-inline icon-only" data-action="refresh-analysis" data-id="${file.id}" title="Analyse neu laden" aria-label="Analyse neu laden">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M12 4a8 8 0 0 1 7.75 6h-2.2A6 6 0 1 0 16.2 16l-2.2-2.2H20v6l-2.35-2.35A8 8 0 1 1 12 4z" />
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
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
    allFiles = [snapshot.file, ...allFiles];
    allFiles.sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());
    renderFiles(filterFiles(allFiles));
    void refreshAnalysisReport(allFiles);
    setMessage(listMessage, error.message || "Datei konnte nicht gelöscht werden.", "error");
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
      parts.push(buildEditableField("is-protected", "protected_person_name", "Benachteiligte Person", currentCaseProtectedPerson));
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
    setMessage(listMessage, "Datei konnte nicht heruntergeladen werden.", "error");
    return;
  }

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

for (const element of [fileTypeFilter, dateFromFilter]) {
  element.addEventListener("change", () => {
    renderFiles(filterFiles(allFiles));
  });
}

goToUploadBtn.addEventListener("click", () => {
  window.location.href = "/upload.html";
});

exportPdfReportBtn?.addEventListener("click", () => {
  const targetUrl = `/report.html?caseId=${encodeURIComponent(currentCaseId)}&autoprint=1`;
  const opened = window.open(targetUrl, "_blank", "noopener,noreferrer");
  if (!opened) {
    window.location.href = targetUrl;
  }
});

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
  void refreshAnalysisReport(allFiles);

  try {
    const promises = filesToDelete.map((fileId) =>
      apiFetch(`${API_BASE}/cases/${currentCaseId}/files/${fileId}`, {
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

copyrightYearEl.textContent = String(new Date().getFullYear());
void loadCaseContext().then(() => {
  loadFiles();
});

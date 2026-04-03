const token = sessionStorage.getItem("token");
if (!token) {
  window.location.replace("/");
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

function maybeShowServiceAlert(status, detail) {
  if (OUTAGE_STATUSES.has(Number(status))) {
    showServiceAlert(detail);
  }
}

const caseForm = document.getElementById("caseForm");
const caseMessage = document.getElementById("caseMessage");
const caseNameInput = document.getElementById("caseName");
const countrySelect = document.getElementById("countrySelect");
const regionSelect = document.getElementById("regionSelect");
const citySelect = document.getElementById("citySelect");
const protectedPersonNameInput = document.getElementById("protectedPersonName");
const opposingPartyNameInput = document.getElementById("opposingPartyName");
const createCaseBtn = document.getElementById("createCaseBtn");
const logoutBtn = document.getElementById("logoutBtn");
const existingCasesSelect = document.getElementById("existingCasesSelect");
const copyrightYearEl = document.getElementById("copyrightYear");

const REGIONS_BY_COUNTRY = [
  {
    country: "Schweiz",
    label: "Kanton",
    options: [
      "Aargau", "Appenzell Ausserrhoden", "Appenzell Innerrhoden", "Basel-Landschaft",
      "Basel-Stadt", "Bern", "Freiburg", "Genf", "Glarus", "Graubünden", "Jura",
      "Luzern", "Neuenburg", "Nidwalden", "Obwalden", "Schaffhausen", "Schwyz",
      "Solothurn", "St. Gallen", "Tessin", "Thurgau", "Uri", "Waadt", "Wallis",
      "Zug", "Zürich"
    ]
  },
  {
    country: "Deutschland",
    label: "Bundesland",
    options: [
      "Baden-Württemberg", "Bayern", "Berlin", "Brandenburg", "Bremen", "Hamburg",
      "Hessen", "Mecklenburg-Vorpommern", "Niedersachsen", "Nordrhein-Westfalen",
      "Rheinland-Pfalz", "Saarland", "Sachsen", "Sachsen-Anhalt",
      "Schleswig-Holstein", "Thüringen"
    ]
  },
  {
    country: "Österreich",
    label: "Bundesland",
    options: [
      "Burgenland", "Kärnten", "Niederösterreich", "Oberösterreich",
      "Salzburg", "Steiermark", "Tirol", "Vorarlberg", "Wien"
    ]
  }
];

function findRegionEntry(country) {
  const needle = String(country || "").trim().toLowerCase().normalize("NFC");
  return REGIONS_BY_COUNTRY.find(
    (e) => e.country.toLowerCase().normalize("NFC") === needle
  ) || null;
}

const CITIES_BY_REGION = {
  Schweiz: {
    "Aargau": ["Aarau", "Baden", "Brugg", "Lenzburg", "Rheinfelden", "Wettingen", "Zofingen"],
    "Appenzell Ausserrhoden": ["Herisau", "Speicher", "Trogen"],
    "Appenzell Innerrhoden": ["Appenzell"],
    "Basel-Landschaft": ["Allschwil", "Arlesheim", "Binningen", "Bottmingen", "Laufen", "Liestal", "Muttenz", "Pratteln", "Reinach", "Sissach"],
    "Basel-Stadt": ["Basel", "Bettingen", "Riehen"],
    "Bern": ["Bern", "Biel/Bienne", "Burgdorf", "Köniz", "Langenthal", "Münsingen", "Steffisburg", "Thun"],
    "Freiburg": ["Bulle", "Düdingen", "Freiburg", "Murten"],
    "Genf": ["Carouge", "Genf", "Lancy", "Meyrin", "Vernier"],
    "Luzern": ["Emmen", "Horw", "Kriens", "Luzern", "Sursee", "Wolhusen"],
    "Neuenburg": ["La Chaux-de-Fonds", "Le Locle", "Neuenburg"],
    "Nidwalden": ["Buochs", "Hergiswil", "Stans"],
    "Obwalden": ["Engelberg", "Sarnen"],
    "Schaffhausen": ["Neuhausen am Rheinfall", "Schaffhausen"],
    "Schwyz": ["Einsiedeln", "Freienbach", "Küssnacht", "Schwyz"],
    "Solothurn": ["Grenchen", "Olten", "Solothurn"],
    "St. Gallen": ["Gossau", "Rapperswil-Jona", "Rorschach", "St. Gallen", "Wil"],
    "Tessin": ["Bellinzona", "Locarno", "Lugano", "Mendrisio"],
    "Thurgau": ["Arbon", "Frauenfeld", "Kreuzlingen"],
    "Uri": ["Altdorf", "Andermatt"],
    "Waadt": ["Lausanne", "Montreux", "Nyon", "Renens", "Yverdon-les-Bains"],
  },
  Deutschland: {
    "Baden-Württemberg": ["Freiburg im Breisgau", "Heidelberg", "Heilbronn", "Karlsruhe", "Konstanz", "Mannheim", "Pforzheim", "Ravensburg", "Stuttgart", "Ulm"],
    "Bayern": ["Augsburg", "Bamberg", "Bayreuth", "Erlangen", "Ingolstadt", "Kempten", "München", "Nürnberg", "Regensburg", "Würzburg"],
    "Berlin": ["Berlin"],
    "Brandenburg": ["Brandenburg an der Havel", "Cottbus", "Frankfurt (Oder)", "Potsdam"],
    "Bremen": ["Bremen", "Bremerhaven"],
    "Hamburg": ["Hamburg"],
    "Hessen": ["Darmstadt", "Frankfurt am Main", "Fulda", "Kassel", "Marburg", "Offenbach am Main", "Wiesbaden"],
    "Mecklenburg-Vorpommern": ["Greifswald", "Neubrandenburg", "Rostock", "Schwerin", "Stralsund"],
    "Niedersachsen": ["Braunschweig", "Göttingen", "Hannover", "Lüneburg", "Oldenburg", "Osnabrück", "Wolfsburg"],
    "Nordrhein-Westfalen": ["Aachen", "Bielefeld", "Bochum", "Bonn", "Dortmund", "Düsseldorf", "Duisburg", "Essen", "Köln", "Münster", "Wuppertal"],
    "Rheinland-Pfalz": ["Kaiserslautern", "Koblenz", "Ludwigshafen", "Mainz", "Trier"],
    "Saarland": ["Homburg", "Neunkirchen", "Saarbrücken"],
    "Sachsen": ["Chemnitz", "Dresden", "Leipzig", "Zwickau"],
    "Sachsen-Anhalt": ["Dessau-Roßlau", "Halle (Saale)", "Magdeburg"],
    "Schleswig-Holstein": ["Flensburg", "Kiel", "Lübeck", "Neumünster"],
    "Thüringen": ["Erfurt", "Gera", "Jena", "Weimar"]
  },
  Österreich: {
    "Burgenland": ["Eisenstadt", "Güssing", "Jennersdorf", "Mattersburg", "Neusiedl am See", "Oberpullendorf", "Oberwart"],
    "Kärnten": ["Klagenfurt", "Spittal an der Drau", "Villach", "Wolfsberg"],
    "Niederösterreich": ["Amstetten", "Krems an der Donau", "Sankt Pölten", "Wiener Neustadt"],
    "Oberösterreich": ["Gmunden", "Linz", "Steyr", "Wels"],
    "Salzburg": ["Hallein", "Salzburg", "Zell am See"],
    "Steiermark": ["Bruck an der Mur", "Graz", "Kapfenberg", "Leoben"],
    "Tirol": ["Hall in Tirol", "Innsbruck", "Kufstein", "Lienz"],
    "Vorarlberg": ["Bludenz", "Bregenz", "Dornbirn", "Feldkirch"],
    "Wien": ["Wien"]
  }
};

function populateRegionOptions(country, preferred = "") {
  const selectedCountry = String(country || "").trim();
  const entry = findRegionEntry(selectedCountry);
  const regions = entry?.options || [];
  const label = entry?.label || "Region";

  regionSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = regions.length > 0 ? `${label} wählen` : "Zuerst Land wählen";
  regionSelect.appendChild(placeholder);

  for (const region of regions) {
    const option = document.createElement("option");
    option.value = region;
    option.textContent = region;
    regionSelect.appendChild(option);
  }

  regionSelect.disabled = regions.length === 0;
  regionSelect.setAttribute("aria-label", label);

  if (preferred && regions.includes(preferred)) {
    regionSelect.value = preferred;
  } else {
    regionSelect.value = "";
  }
  populateCityOptions(country, regionSelect.value);
}

function populateCityOptions(country, region, preferred = "") {
  const cities = (CITIES_BY_REGION[country] || {})[region] || [];

  citySelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = cities.length > 0 ? "Ortschaft / Sitz des Gerichts wählen" : (region ? "Keine Ortschaften verfügbar" : "Zuerst Kanton / Bundesland wählen");
  citySelect.appendChild(placeholder);

  for (const city of cities) {
    const option = document.createElement("option");
    option.value = city;
    option.textContent = city;
    citySelect.appendChild(option);
  }

  citySelect.disabled = cities.length === 0;
  citySelect.value = (preferred && cities.includes(preferred)) ? preferred : "";
}

function todayIsoDate() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 10);
}

function generateCaseId() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function setMessage(el, text, type) {
  el.textContent = text;
  el.classList.remove("error", "success");
  if (type) {
    el.classList.add(type);
  }
}

function formatCaseTimestamp(value) {
  if (!value) {
    return "--.--.---- --:--";
  }

  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) {
    return "--.--.---- --:--";
  }

  const day = String(dt.getDate()).padStart(2, "0");
  const month = String(dt.getMonth() + 1).padStart(2, "0");
  const year = dt.getFullYear();
  const hour = String(dt.getHours()).padStart(2, "0");
  const minute = String(dt.getMinutes()).padStart(2, "0");
  return `${day}.${month}.${year} ${hour}:${minute}`;
}

async function loadCasesList() {
  try {
    const res = await apiFetch(`${API_BASE}/cases`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      maybeShowServiceAlert(res.status, "Dossierliste nicht verfügbar");
      existingCasesSelect.innerHTML = "<option value=\"\">Fallliste konnte nicht geladen werden</option>";
      setMessage(caseMessage, data.error || "Fallliste konnte nicht geladen werden.", "error");
      return;
    }

    const cases = Array.isArray(data.cases) ? [...data.cases] : [];
    cases.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    existingCasesSelect.innerHTML = "";

    const placeholder = document.createElement("option");
    placeholder.value = "";
    placeholder.textContent = cases.length > 0
      ? "Bitte Dossier auswählen"
      : "Noch keine Dossiers vorhanden";
    existingCasesSelect.appendChild(placeholder);

    for (const item of cases) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = `${item.id} – ${item.case_name}`;
      existingCasesSelect.appendChild(option);
    }
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
    showServiceAlert("Keine Verbindung zum Backend");
    existingCasesSelect.innerHTML = "<option value=\"\">Fallliste konnte nicht geladen werden</option>";
    setMessage(caseMessage, "Backend nicht erreichbar. Bitte Seite neu laden.", "error");
  }
}

function openUploadForCase(caseId) {
  const normalized = String(caseId || "").trim();
  if (!/^\d{6}$/.test(normalized)) {
    setMessage(caseMessage, "Bitte eine gültige 6-stellige Fall-ID auswählen.", "error");
    return;
  }

  sessionStorage.setItem("currentCaseId", normalized);
  window.location.href = "/upload.html";
}

function openListForCase(caseId) {
  const normalized = String(caseId || "").trim();
  if (!/^\d{6}$/.test(normalized)) {
    setMessage(caseMessage, "Bitte eine gültige 6-stellige Fall-ID auswählen.", "error");
    return;
  }

  sessionStorage.setItem("currentCaseId", normalized);
  window.location.href = "/files.html";
}

caseForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const caseDate = todayIsoDate();
  const caseName = String(caseNameInput.value || "").trim();
  const country = String(countrySelect?.value || "").trim();
  const region = String(regionSelect?.value || "").trim();
  const city = String(citySelect?.value || "").trim();
  const protectedPersonName = String(protectedPersonNameInput?.value || "").trim();
  const opposingPartyName = String(opposingPartyNameInput?.value || "").trim();

  if (!caseName) {
    setMessage(caseMessage, "Bitte einen Namen eingeben.", "error");
    return;
  }

  if (!country || !region) {
    setMessage(caseMessage, "Bitte zuerst Land und danach Region (Kanton/Bundesland) auswählen.", "error");
    return;
  }

  createCaseBtn.disabled = true;

  try {
    let created = null;
    let tries = 0;
    let nextCaseId = generateCaseId();

    while (!created && tries < 6) {
      tries += 1;
      const res = await apiFetch(`${API_BASE}/cases`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          caseId: nextCaseId,
          caseDate,
          caseName,
          country: country || null,
          region: region || null,
          city: city || null,
          protected_person_name: protectedPersonName || null,
          opposing_party: opposingPartyName || null
        })
      });

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        created = data;
        break;
      }

      if (res.status === 409) {
        nextCaseId = generateCaseId();
        continue;
      }

      maybeShowServiceAlert(res.status, "Dossier-Erstellung derzeit gestört");

      setMessage(caseMessage, data.error || "Fall konnte nicht erstellt werden.", "error");
      return;
    }

    if (!created) {
      setMessage(caseMessage, "Konnte keine freie Fall-ID erzeugen. Bitte erneut versuchen.", "error");
      return;
    }

    sessionStorage.setItem("currentCaseId", created.id);
    window.location.href = "/upload.html";
  } catch (error) {
    if (error instanceof Error && error.message === "AUTH_REDIRECT") {
      return;
    }
    showServiceAlert("Keine Verbindung zum Backend");
    setMessage(caseMessage, "Backend nicht erreichbar. Bitte später erneut versuchen.", "error");
  } finally {
    createCaseBtn.disabled = false;
  }
});

existingCasesSelect.addEventListener("change", () => {
  if (!existingCasesSelect.value) return;
  openListForCase(existingCasesSelect.value);
});

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem("token");
  sessionStorage.removeItem("currentCaseId");
  window.location.href = "/";
});

if (countrySelect instanceof HTMLSelectElement && regionSelect instanceof HTMLSelectElement) {
  countrySelect.addEventListener("change", () => {
    populateRegionOptions(countrySelect.value);
  });
  regionSelect.addEventListener("change", () => {
    populateCityOptions(countrySelect.value, regionSelect.value);
  });
  populateRegionOptions(countrySelect.value);
}

if (copyrightYearEl) copyrightYearEl.textContent = String(new Date().getFullYear());

// Hide "Neuen Fall anlegen" for Team members (collaborators)
const role = sessionStorage.getItem("dmski_role") || "customer";
if (role === "collaborator") {
  const newCaseCard = document.querySelector(".card-new-case");
  if (newCaseCard) newCaseCard.style.display = "none";
  // Make open-case card full width
  const openCaseCard = document.querySelector(".card-open-case");
  if (openCaseCard) openCaseCard.style.gridColumn = "1 / -1";
  // Hide welcome strip mentioning "Fall anlegen"
  const welcomeStrip = document.querySelector(".welcome-strip");
  if (welcomeStrip) welcomeStrip.style.display = "none";
}

loadCasesList().then(() => {
  // Alert collaborators if their assigned case was deleted
  if (role === "collaborator") {
    const opts = existingCasesSelect?.querySelectorAll("option[value]") || [];
    const hasCases = [...opts].some(o => o.value && /^\d{6}$/.test(o.value));
    if (!hasCases) {
      const msg = document.createElement("div");
      msg.style.cssText = "max-width:600px;margin:2rem auto;padding:1.5rem 2rem;border:1px solid rgba(220,38,38,0.25);border-radius:14px;background:rgba(220,38,38,0.04);text-align:center;";
      msg.innerHTML = `<p style="font-size:1rem;font-weight:700;color:#dc2626;margin:0 0 .5rem">Ihr Fall wurde gelöscht</p>
        <p style="font-size:.88rem;color:#64748b;margin:0 0 1rem;line-height:1.55">Der Fall, zu dem Sie eingeladen waren, existiert nicht mehr. Falls Sie Fragen haben, wenden Sie sich bitte an die Person, die Sie eingeladen hat.</p>
        <p style="font-size:.82rem;color:#94a3b8;margin:0">Sie können Ihr Profil unter <a href="/profile.html" style="color:#1A2B3C;font-weight:600">Mein Profil</a> verwalten oder dauerhaft löschen.</p>`;
      const main = document.getElementById("dashboardMain");
      if (main) main.appendChild(msg);
    }
  }
});

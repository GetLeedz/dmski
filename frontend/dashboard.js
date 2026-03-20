const token = sessionStorage.getItem("token");
if (!token) {
  window.location.href = "/";
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

const caseForm = document.getElementById("caseForm");
const caseMessage = document.getElementById("caseMessage");
const caseNameInput = document.getElementById("caseName");
const createCaseBtn = document.getElementById("createCaseBtn");
const logoutBtn = document.getElementById("logoutBtn");
const existingCasesSelect = document.getElementById("existingCasesSelect");
const copyrightYearEl = document.getElementById("copyrightYear");

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
    const res = await fetch(`${API_BASE}/cases`, {
      headers: { Authorization: `Bearer ${token}` }
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
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
      const createdLabel = formatCaseTimestamp(item.created_at);
      option.textContent = `${createdLabel} - ${item.id} - ${item.case_name}`;
      existingCasesSelect.appendChild(option);
    }
  } catch {
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

  if (!caseName) {
    setMessage(caseMessage, "Bitte einen Namen eingeben.", "error");
    return;
  }

  createCaseBtn.disabled = true;

  try {
    let created = null;
    let tries = 0;
    let nextCaseId = generateCaseId();

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

      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        created = data;
        break;
      }

      if (res.status === 409) {
        nextCaseId = generateCaseId();
        continue;
      }

      setMessage(caseMessage, data.error || "Fall konnte nicht erstellt werden.", "error");
      return;
    }

    if (!created) {
      setMessage(caseMessage, "Konnte keine freie Fall-ID erzeugen. Bitte erneut versuchen.", "error");
      return;
    }

    sessionStorage.setItem("currentCaseId", created.id);
    window.location.href = "/upload.html";
  } catch {
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

copyrightYearEl.textContent = String(new Date().getFullYear());
loadCasesList();

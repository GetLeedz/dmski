const token = sessionStorage.getItem("token");
if (!token) {
  window.location.href = "/";
}

const API_BASE = window.location.hostname === "localhost"
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

async function loadCasesList() {
  const res = await fetch(`${API_BASE}/cases`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    existingCasesSelect.innerHTML = "<option value=\"\">Fallliste konnte nicht geladen werden</option>";
    return;
  }

  const cases = data.cases || [];
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
    option.textContent = `${item.id} - ${item.case_name} (${String(item.case_date || "")})`;
    existingCasesSelect.appendChild(option);
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

caseForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const caseDate = todayIsoDate();
  const caseName = String(caseNameInput.value || "").trim();

  if (!caseName) {
    setMessage(caseMessage, "Bitte einen Namen eingeben.", "error");
    return;
  }

  createCaseBtn.disabled = true;

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
    createCaseBtn.disabled = false;
    return;
  }

  createCaseBtn.disabled = false;

  if (!created) {
    setMessage(caseMessage, "Konnte keine freie Fall-ID erzeugen. Bitte erneut versuchen.", "error");
    return;
  }

  sessionStorage.setItem("currentCaseId", created.id);
  window.location.href = "/upload.html";
});

existingCasesSelect.addEventListener("change", () => {
  if (!existingCasesSelect.value) return;
  openUploadForCase(existingCasesSelect.value);
});

logoutBtn.addEventListener("click", () => {
  sessionStorage.removeItem("token");
  sessionStorage.removeItem("currentCaseId");
  window.location.href = "/";
});

copyrightYearEl.textContent = String(new Date().getFullYear());
loadCasesList();

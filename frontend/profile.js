/* profile.js – DMSKI Profile & User Management */

// Same URL detection as dashboard.js / upload.js / files.js
const _host = String(window.location.hostname || "").toLowerCase();
const _isLocal = _host === "localhost"
  || _host === "127.0.0.1"
  || _host === "0.0.0.0"
  || _host === "::1"
  || _host.endsWith(".local")
  || /^192\.168\./.test(_host)
  || /^10\./.test(_host)
  || /^172\.(1[6-9]|2\d|3[0-1])\./.test(_host);

const API = _isLocal
  ? "http://localhost:4000"
  : "https://lively-reverence-production-def3.up.railway.app";

// ── Auth helpers (aligned with the rest of the app: sessionStorage "token") ──
function getToken()  { return sessionStorage.getItem("token") || ""; }
function getRole()   { return sessionStorage.getItem("dmski_role") || "customer"; }
function getUserId() { return Number(sessionStorage.getItem("dmski_user_id") || 0); }

function authHeaders() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` };
}

function redirectToLogin(reason) {
  console.warn("Profile redirect to login:", reason);
  sessionStorage.removeItem("token");
  window.location.replace("/");
}

// ── Init ────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("copyrightYear").textContent = new Date().getFullYear();

  const token = getToken();
  if (!token) { redirectToLogin("no token"); return; }

  document.getElementById("logoutBtn").addEventListener("click", () => {
    sessionStorage.removeItem("token");
    sessionStorage.removeItem("currentCaseId");
    window.location.href = "/";
  });

  // Show main content eagerly; hide loading gate
  document.getElementById("authGate").style.display  = "none";
  document.getElementById("profileMain").style.display = "";

  try {
    await loadProfile();
  } catch (err) {
    // Only redirect to login on actual auth errors (401/403)
    if (err.status === 401 || err.status === 403) {
      redirectToLogin("auth error");
      return;
    }
    // Other errors: show message but stay on page
    console.error("Profile load error:", err);
    showToast("Profil konnte nicht geladen werden. Bitte Seite neu laden.", "error");
    return;
  }

  const role = getRole();
  if (role === "admin") {
    document.getElementById("sectionAdmin").style.display = "";
    loadCustomers();
  }
  loadCollabs(getUserId());

  // Forms
  document.getElementById("profileForm").addEventListener("submit", onSaveProfile);
  document.getElementById("addCollabForm").addEventListener("submit", onAddCollab);
  document.getElementById("newCustomerForm").addEventListener("submit", onCreateCustomer);
});

// ── Load current user profile ───────────────────────────────────────────────
async function loadProfile() {
  const res = await fetch(`${API}/users/me`, { headers: authHeaders() });

  if (res.status === 401 || res.status === 403) {
    const err = new Error("Nicht autorisiert");
    err.status = res.status;
    throw err;
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "Fehler beim Laden des Profils");
    err.status = res.status;
    throw err;
  }

  const { user } = await res.json();

  // Store role & id for later use (session-scoped)
  sessionStorage.setItem("dmski_role",    user.role || "customer");
  sessionStorage.setItem("dmski_user_id", String(user.id));

  // Avatar letter
  const letter = (user.first_name || user.email || "?")[0].toUpperCase();
  document.getElementById("avatarLetter").textContent = letter;
  document.getElementById("profileName").textContent  =
    [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;
  document.getElementById("profileEmail").textContent = user.email;

  // Role badge
  const badge = document.getElementById("profileBadge");
  const labels = { admin: "Administrator", customer: "Kunde", collaborator: "Mitarbeiter" };
  badge.textContent = labels[user.role] || user.role;
  badge.className   = `badge-role badge-${user.role || "customer"}`;

  // Fill form
  document.getElementById("fieldFirstName").value = user.first_name || "";
  document.getElementById("fieldLastName").value  = user.last_name  || "";
  document.getElementById("fieldEmail").value     = user.email      || "";
  document.getElementById("fieldAddress").value   = user.address    || "";
  document.getElementById("fieldMobile").value    = user.mobile     || "";
}

// ── Save profile ────────────────────────────────────────────────────────────
async function onSaveProfile(e) {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  const msg = document.getElementById("profileMsg");
  setMsg(msg, "");

  const newPwd  = document.getElementById("fieldNewPwd").value.trim();
  const newPwd2 = document.getElementById("fieldNewPwd2").value.trim();
  const curPwd  = document.getElementById("fieldCurrentPwd").value;

  if (newPwd && newPwd !== newPwd2) {
    setMsg(msg, "Die neuen Passwörter stimmen nicht überein.", "error"); return;
  }

  const body = {
    email:      document.getElementById("fieldEmail").value.trim(),
    first_name: document.getElementById("fieldFirstName").value.trim(),
    last_name:  document.getElementById("fieldLastName").value.trim(),
    address:    document.getElementById("fieldAddress").value.trim(),
    mobile:     document.getElementById("fieldMobile").value.trim(),
  };
  if (newPwd) { body.password = newPwd; body.currentPassword = curPwd; }

  if (btn) { btn.disabled = true; btn.textContent = "Speichert …"; }

  try {
    const res  = await fetch(`${API}/users/me`, {
      method: "PATCH", headers: authHeaders(), body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { setMsg(msg, data.error || "Fehler beim Speichern.", "error"); return; }
    setMsg(msg, "✓ Profil erfolgreich gespeichert.", "success");
    ["fieldCurrentPwd","fieldNewPwd","fieldNewPwd2"].forEach(id =>
      (document.getElementById(id).value = ""));
    await loadProfile();
  } catch {
    setMsg(msg, "Netzwerkfehler. Bitte erneut versuchen.", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Speichern"; }
  }
}

// ── Load collaborators ──────────────────────────────────────────────────────
async function loadCollabs(userId) {
  if (!userId) return;
  const el = document.getElementById("collabList");
  try {
    const res  = await fetch(`${API}/users/${userId}/collaborators`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { el.innerHTML = `<p class="empty-state">${escHtml(data.error || "Fehler")}</p>`; return; }
    renderCollabs(data.collaborators || [], userId, el);
  } catch {
    el.innerHTML = `<p class="empty-state">Mitarbeiterliste konnte nicht geladen werden.</p>`;
  }
}

function renderCollabs(list, userId, el) {
  if (list.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
          <circle cx="9" cy="7" r="4"/><path d="M1 21c0-4.418 3.582-8 8-8"/>
          <path d="M19 11v6M22 14h-6" stroke-width="1.8" stroke-linecap="round"/>
        </svg>
        <span>Noch keine Fachpersonen hinzugefügt.</span>
      </div>`;
    return;
  }
  el.innerHTML = list.map(c => {
    const name    = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email;
    const letter  = (c.first_name || c.email || "?")[0].toUpperCase();
    const fn      = escHtml(c.function_label || c.role || "Fachperson");
    return `<div class="fach-card">
      <div class="fach-avatar">${escHtml(letter)}</div>
      <div class="fach-info">
        <div class="fach-name">${escHtml(name)}</div>
        <div class="fach-email">${escHtml(c.email)}</div>
      </div>
      <span class="fach-role-badge">${fn}</span>
      <button class="fach-remove" data-uid="${userId}" data-lid="${c.id}" title="Zugang entfernen">
        <svg viewBox="0 0 16 16" stroke-width="1.5" stroke-linecap="round"><path d="M3 4h10M6 4V3h4v1M5 4v8h6V4"/></svg>
      </button>
    </div>`;
  }).join("");

  el.querySelectorAll(".fach-remove").forEach(btn =>
    btn.addEventListener("click", () =>
      removeCollab(Number(btn.dataset.uid), Number(btn.dataset.lid))));
}

async function removeCollab(userId, linkId) {
  if (!confirm("Mitarbeiter wirklich entfernen?")) return;
  try {
    await fetch(`${API}/users/${userId}/collaborators/${linkId}`,
      { method: "DELETE", headers: authHeaders() });
    loadCollabs(userId);
  } catch { showToast("Fehler beim Entfernen.", "error"); }
}

// ── Add collaborator ────────────────────────────────────────────────────────
async function onAddCollab(e) {
  e.preventDefault();
  const msg    = document.getElementById("collabMsg");
  const pwdBox = document.getElementById("collabPwdBox");
  setMsg(msg, ""); pwdBox.style.display = "none";

  const email     = document.getElementById("collabEmail").value.trim();
  const fn        = document.getElementById("collabFunction").value;
  const firstName = document.getElementById("collabFirstName").value.trim();
  const lastName  = document.getElementById("collabLastName").value.trim();
  const userId    = getUserId();

  if (!fn) { setMsg(msg, "Bitte Funktion auswählen.", "error"); return; }

  const btn = e.target.querySelector("button[type=submit]");
  if (btn) { btn.disabled = true; btn.textContent = "Wird hinzugefügt …"; }

  try {
    const res  = await fetch(`${API}/users/${userId}/collaborators`, {
      method: "POST", headers: authHeaders(),
      body: JSON.stringify({
        email,
        function_label: fn,
        first_name: firstName || undefined,
        last_name:  lastName  || undefined
      })
    });
    const data = await res.json();
    if (!res.ok) { setMsg(msg, data.error || "Fehler.", "error"); return; }

    setMsg(msg, data.isNewUser
      ? `✓ Konto erstellt & Zugang eingerichtet für ${email}.`
      : `✓ Zugang für ${email} eingerichtet.`, "success");

    if (data.generatedPassword) {
      pwdBox.style.display = "";
      pwdBox.innerHTML = buildPwdBox("Temporäres Passwort", data.generatedPassword,
        "⚠️ Dieses Passwort wird nur einmal angezeigt. Bitte sicher weitergeben.");
      pwdBox.querySelector(".copy-btn")?.addEventListener("click", function() {
        copyPwd(data.generatedPassword, this);
      });
    }

    document.getElementById("collabEmail").value    = "";
    document.getElementById("collabFunction").value = "";
    loadCollabs(userId);
  } catch {
    setMsg(msg, "Netzwerkfehler.", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Hinzufügen & Zugang erstellen"; }
  }
}

// ── Admin: load customers ───────────────────────────────────────────────────
async function loadCustomers() {
  const el = document.getElementById("customerList");
  try {
    const res  = await fetch(`${API}/users`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { el.innerHTML = `<p class="empty-state">${escHtml(data.error)}</p>`; return; }

    const customers = (data.users || []).filter(u => u.role !== "admin");
    if (customers.length === 0) {
      el.innerHTML = `<p class="empty-state">Noch keine Kunden vorhanden.</p>`; return;
    }

    el.innerHTML = customers.map(u => {
      const name  = [u.first_name, u.last_name].filter(Boolean).join(" ") || "–";
      const isCollab = u.role === "collaborator";
      return `<div class="customer-card">
        <div class="customer-avatar">${(u.first_name || u.email || "?")[0].toUpperCase()}</div>
        <div class="customer-info">
          <div class="customer-name">${escHtml(name)}</div>
          <div class="customer-email">${escHtml(u.email)}</div>
        </div>
        <span style="background:${isCollab ? "#e0e7ff" : "#d1fae5"};color:${isCollab ? "#3730a3" : "#065f46"};
          padding:.15rem .55rem;border-radius:6px;font-size:.75rem;font-weight:600">
          ${isCollab ? "Mitarbeiter" : "Kunde"}
        </span>
      </div>`;
    }).join("");
  } catch {
    el.innerHTML = `<p class="empty-state">Kundenliste konnte nicht geladen werden.</p>`;
  }
}

// ── Admin: create customer ──────────────────────────────────────────────────
async function onCreateCustomer(e) {
  e.preventDefault();
  const msg    = document.getElementById("newCustomerMsg");
  const pwdBox = document.getElementById("newCustomerPwdBox");
  setMsg(msg, ""); pwdBox.style.display = "none";

  const body = {
    email:      document.getElementById("ncEmail").value.trim(),
    first_name: document.getElementById("ncFirstName").value.trim() || undefined,
    last_name:  document.getElementById("ncLastName").value.trim()  || undefined,
    address:    document.getElementById("ncAddress").value.trim()   || undefined,
    mobile:     document.getElementById("ncMobile").value.trim()    || undefined,
  };

  const btn = e.target.querySelector("button[type=submit]");
  if (btn) { btn.disabled = true; btn.textContent = "Erstellt …"; }

  try {
    const res  = await fetch(`${API}/users/customers`, {
      method: "POST", headers: authHeaders(), body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { setMsg(msg, data.error || "Fehler.", "error"); return; }

    const name = [data.user.first_name, data.user.last_name].filter(Boolean).join(" ") || data.user.email;
    setMsg(msg, `✓ Kunde «${escHtml(name)}» erfolgreich erstellt.`, "success");

    pwdBox.style.display = "";
    pwdBox.innerHTML = buildPwdBox(
      `Temporäres Passwort für ${data.user.email}`, data.generatedPassword,
      "⚠️ Dieses Passwort wird nur einmal angezeigt. Bitte sicher an den Kunden weitergeben."
    );
    pwdBox.querySelector(".copy-btn")?.addEventListener("click", function() {
      copyPwd(data.generatedPassword, this);
    });

    e.target.reset();
    loadCustomers();
  } catch {
    setMsg(msg, "Netzwerkfehler.", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Kunden erstellen & Passwort generieren"; }
  }
}

// ── Admin tabs ──────────────────────────────────────────────────────────────
function showAdminTab(tab) {
  document.getElementById("adminListView").style.display = tab === "list" ? "" : "none";
  document.getElementById("adminNewView").style.display  = tab === "new"  ? "" : "none";
  document.getElementById("tabListCustomers").classList.toggle("active", tab === "list");
  document.getElementById("tabNewCustomer").classList.toggle("active",   tab === "new");
}

// ── Utilities ───────────────────────────────────────────────────────────────
function setMsg(el, text, type) {
  el.textContent = text;
  el.className   = `message${type ? ` message--${type}` : ""}`;
}

function showToast(text, type = "info") {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = `position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);
    padding:.65rem 1.2rem;border-radius:8px;font-size:.88rem;font-weight:600;z-index:9999;
    background:${type === "error" ? "#fdf0ef" : "#edf8f1"};
    border:1.5px solid ${type === "error" ? "#f5c6c1" : "#6ee7b7"};
    color:${type === "error" ? "#b91c1c" : "#065f46"};
    box-shadow:0 4px 16px rgba(0,0,0,.12)`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function buildPwdBox(label, pwd, hint) {
  return `<div class="generated-pwd">
    <span>${escHtml(label)}:</span>
    <strong>${escHtml(pwd)}</strong>
    <button class="copy-btn" style="margin-left:auto;flex-shrink:0;padding:.2rem .5rem;
      border:1px solid #6ee7b7;background:#fff;border-radius:6px;cursor:pointer;
      font-size:.8rem;color:#065f46">Kopieren</button>
  </div>
  <p style="font-size:.78rem;color:#6b8896;margin:.4rem 0 0">${escHtml(hint)}</p>`;
}

function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function copyPwd(pwd, btn) {
  navigator.clipboard.writeText(pwd).then(() => {
    const orig = btn.textContent;
    btn.textContent = "✓ Kopiert";
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
}

// Expose to inline onclick
window.showAdminTab = showAdminTab;

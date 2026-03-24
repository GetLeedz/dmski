/* profile.js – DMSKI Profile & User Management */

const API = (window.__ENV_API_URL || "https://dmski-backend-production.up.railway.app").replace(/\/$/, "");

// ── Auth helpers ────────────────────────────────────────────────────────────
function getToken() { return localStorage.getItem("dmski_token") || ""; }
function getRole()  { return localStorage.getItem("dmski_role")  || "customer"; }
function getUserId(){ return Number(localStorage.getItem("dmski_user_id") || 0); }

function authHeaders() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` };
}

// ── Init ────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("copyrightYear").textContent = new Date().getFullYear();

  const token = getToken();
  if (!token) { window.location.href = "/index.html"; return; }

  document.getElementById("logoutBtn").addEventListener("click", () => {
    localStorage.clear();
    window.location.href = "/index.html";
  });

  try {
    await loadProfile();
    const role = getRole();
    if (role === "admin") {
      document.getElementById("sectionAdmin").style.display = "";
      loadCustomers();
    }
    loadCollabs(getUserId());
  } catch {
    localStorage.clear();
    window.location.href = "/index.html";
    return;
  }

  document.getElementById("authGate").style.display  = "none";
  document.getElementById("profileMain").style.display = "";

  // Forms
  document.getElementById("profileForm").addEventListener("submit", onSaveProfile);
  document.getElementById("addCollabForm").addEventListener("submit", onAddCollab);
  document.getElementById("newCustomerForm").addEventListener("submit", onCreateCustomer);
});

// ── Load current user profile ───────────────────────────────────────────────
async function loadProfile() {
  const res = await fetch(`${API}/users/me`, { headers: authHeaders() });
  if (!res.ok) throw new Error("Nicht autorisiert");
  const { user } = await res.json();

  // Store role & id for later use
  localStorage.setItem("dmski_role",    user.role || "customer");
  localStorage.setItem("dmski_user_id", user.id);

  // Avatar letter
  const letter = (user.first_name || user.email || "?")[0].toUpperCase();
  document.getElementById("avatarLetter").textContent = letter;
  document.getElementById("profileName").textContent  =
    [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;
  document.getElementById("profileEmail").textContent = user.email;

  // Badge
  const badge = document.getElementById("profileBadge");
  const labels = { admin: "Administrator", customer: "Kunde", collaborator: "Mitarbeiter" };
  badge.textContent  = labels[user.role] || user.role;
  badge.className    = `badge-role badge-${user.role || "customer"}`;

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
  const msg = document.getElementById("profileMsg");
  msg.textContent = "";
  msg.className   = "message";

  const newPwd  = document.getElementById("fieldNewPwd").value.trim();
  const newPwd2 = document.getElementById("fieldNewPwd2").value.trim();
  const curPwd  = document.getElementById("fieldCurrentPwd").value;

  if (newPwd && newPwd !== newPwd2) {
    setMsg(msg, "Die neuen Passwörter stimmen nicht überein.", "error");
    return;
  }

  const body = {
    email:      document.getElementById("fieldEmail").value.trim(),
    first_name: document.getElementById("fieldFirstName").value.trim(),
    last_name:  document.getElementById("fieldLastName").value.trim(),
    address:    document.getElementById("fieldAddress").value.trim(),
    mobile:     document.getElementById("fieldMobile").value.trim(),
  };
  if (newPwd) { body.password = newPwd; body.currentPassword = curPwd; }

  try {
    const res = await fetch(`${API}/users/me`, {
      method: "PATCH",
      headers: authHeaders(),
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { setMsg(msg, data.error || "Fehler beim Speichern.", "error"); return; }
    setMsg(msg, "Profil erfolgreich gespeichert.", "success");
    // Clear password fields
    ["fieldCurrentPwd","fieldNewPwd","fieldNewPwd2"].forEach(id =>
      document.getElementById(id).value = "");
    await loadProfile();
  } catch {
    setMsg(msg, "Netzwerkfehler. Bitte erneut versuchen.", "error");
  }
}

// ── Load collaborators ──────────────────────────────────────────────────────
async function loadCollabs(userId) {
  const el = document.getElementById("collabList");
  try {
    const res = await fetch(`${API}/users/${userId}/collaborators`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { el.innerHTML = `<p class="empty-state">${data.error || "Fehler"}</p>`; return; }
    renderCollabs(data.collaborators || [], userId, el);
  } catch {
    el.innerHTML = `<p class="empty-state">Mitarbeiterliste konnte nicht geladen werden.</p>`;
  }
}

function renderCollabs(list, userId, el) {
  if (list.length === 0) {
    el.innerHTML = `<p class="empty-state">Noch keine Mitarbeiter hinzugefügt.</p>`;
    return;
  }
  const rows = list.map(c => {
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "–";
    return `<tr>
      <td>${escHtml(c.email)}</td>
      <td>${escHtml(name)}</td>
      <td><span style="background:#e0f2fe;color:#0369a1;padding:.15rem .45rem;border-radius:5px;font-size:.78rem;font-weight:600">${escHtml(c.function_label || c.role || "–")}</span></td>
      <td>
        <button class="btn-remove" onclick="removeCollab(${userId},${c.id})">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none"><path d="M3 4h10M6 4V3h4v1M5 4v8h6V4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          Entfernen
        </button>
      </td>
    </tr>`;
  }).join("");
  el.innerHTML = `<table class="collab-table">
    <thead><tr><th>E-Mail</th><th>Name</th><th>Funktion</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

async function removeCollab(userId, linkId) {
  if (!confirm("Mitarbeiter wirklich entfernen?")) return;
  try {
    await fetch(`${API}/users/${userId}/collaborators/${linkId}`, {
      method: "DELETE", headers: authHeaders()
    });
    loadCollabs(userId);
  } catch { alert("Fehler beim Entfernen."); }
}

// ── Add collaborator ────────────────────────────────────────────────────────
async function onAddCollab(e) {
  e.preventDefault();
  const msg   = document.getElementById("collabMsg");
  const pwdBox = document.getElementById("collabPwdBox");
  msg.textContent = ""; msg.className = "message";
  pwdBox.style.display = "none";

  const email    = document.getElementById("collabEmail").value.trim();
  const fn       = document.getElementById("collabFunction").value;
  const userId   = getUserId();

  if (!fn) { setMsg(msg, "Bitte Funktion auswählen.", "error"); return; }

  try {
    const res = await fetch(`${API}/users/${userId}/collaborators`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email, function_label: fn })
    });
    const data = await res.json();
    if (!res.ok) { setMsg(msg, data.error || "Fehler.", "error"); return; }

    setMsg(msg, data.isNewUser
      ? `Konto erstellt & Zugang eingerichtet für ${email}.`
      : `Zugang für bestehenden Nutzer ${email} eingerichtet.`, "success");

    if (data.generatedPassword) {
      pwdBox.style.display = "";
      pwdBox.innerHTML = `
        <div class="generated-pwd" id="generatedPwdText">
          <span>Temporäres Passwort:</span>
          <strong>${escHtml(data.generatedPassword)}</strong>
          <button onclick="copyPwd('${escHtml(data.generatedPassword)}',this)">Kopieren</button>
        </div>
        <p style="font-size:.78rem;color:#6b8896;margin:.4rem 0 0">
          ⚠️ Dieses Passwort wird nur einmal angezeigt. Bitte sicher weitergeben.
        </p>`;
    }

    document.getElementById("collabEmail").value    = "";
    document.getElementById("collabFunction").value = "";
    loadCollabs(userId);
  } catch {
    setMsg(msg, "Netzwerkfehler.", "error");
  }
}

// ── Admin: load customers ───────────────────────────────────────────────────
async function loadCustomers() {
  const el = document.getElementById("customerList");
  try {
    const res = await fetch(`${API}/users`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { el.innerHTML = `<p class="empty-state">${data.error}</p>`; return; }

    const customers = (data.users || []).filter(u => u.role !== "admin");
    if (customers.length === 0) {
      el.innerHTML = `<p class="empty-state">Noch keine Kunden vorhanden.</p>`; return;
    }

    el.innerHTML = customers.map(u => {
      const name  = [u.first_name, u.last_name].filter(Boolean).join(" ") || "–";
      const role  = u.role === "collaborator" ? "Mitarbeiter" : "Kunde";
      const color = u.role === "collaborator" ? "#e0e7ff" : "#d1fae5";
      const tc    = u.role === "collaborator" ? "#3730a3" : "#065f46";
      return `<div class="customer-card">
        <div class="customer-avatar">${(u.first_name || u.email || "?")[0].toUpperCase()}</div>
        <div class="customer-info">
          <div class="customer-name">${escHtml(name)}</div>
          <div class="customer-email">${escHtml(u.email)}</div>
        </div>
        <span style="background:${color};color:${tc};padding:.15rem .55rem;border-radius:6px;font-size:.75rem;font-weight:600">${role}</span>
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
  msg.textContent = ""; msg.className = "message";
  pwdBox.style.display = "none";

  const body = {
    email:      document.getElementById("ncEmail").value.trim(),
    first_name: document.getElementById("ncFirstName").value.trim() || undefined,
    last_name:  document.getElementById("ncLastName").value.trim()  || undefined,
    address:    document.getElementById("ncAddress").value.trim()   || undefined,
    mobile:     document.getElementById("ncMobile").value.trim()    || undefined,
  };

  try {
    const res = await fetch(`${API}/users/customers`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { setMsg(msg, data.error || "Fehler.", "error"); return; }

    const name = [data.user.first_name, data.user.last_name].filter(Boolean).join(" ") || data.user.email;
    setMsg(msg, `Kunde «${name}» erfolgreich erstellt.`, "success");

    pwdBox.style.display = "";
    pwdBox.innerHTML = `
      <div class="generated-pwd">
        <span>Temporäres Passwort für ${escHtml(data.user.email)}:</span>
        <strong>${escHtml(data.generatedPassword)}</strong>
        <button onclick="copyPwd('${escHtml(data.generatedPassword)}',this)">Kopieren</button>
      </div>
      <p style="font-size:.78rem;color:#6b8896;margin:.4rem 0 0">
        ⚠️ Dieses Passwort wird nur einmal angezeigt. Bitte sicher an den Kunden weitergeben.
      </p>`;

    // Reset form
    e.target.reset();
    loadCustomers();
  } catch {
    setMsg(msg, "Netzwerkfehler.", "error");
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
  el.className   = `message message--${type}`;
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
window.removeCollab  = removeCollab;
window.showAdminTab  = showAdminTab;
window.copyPwd       = copyPwd;

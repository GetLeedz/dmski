/* profile.js – DMSKI Profile & User Management */

const _host = String(window.location.hostname || "").toLowerCase();
const _isLocal = _host === "localhost" || _host === "127.0.0.1" || _host === "0.0.0.0"
  || _host === "::1" || _host.endsWith(".local")
  || /^192\.168\./.test(_host) || /^10\./.test(_host)
  || /^172\.(1[6-9]|2\d|3[0-1])\./.test(_host);

const API = _isLocal
  ? "http://localhost:4000"
  : "https://lively-reverence-production-def3.up.railway.app";

function getToken()  { return sessionStorage.getItem("token") || ""; }
function getRole()   { return sessionStorage.getItem("dmski_role") || "customer"; }
function getUserId() { return Number(sessionStorage.getItem("dmski_user_id") || 0); }
function authHeaders() {
  return { "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` };
}
function redirectToLogin(reason) {
  console.warn("Profile redirect:", reason);
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

  document.getElementById("authGate").style.display   = "none";
  document.getElementById("profileMain").style.display = "";

  try {
    await loadProfile();
  } catch (err) {
    if (err.status === 401 || err.status === 403) { redirectToLogin("auth error"); return; }
    console.error("Profile load error:", err);
    showToast("Profil konnte nicht geladen werden. Bitte Seite neu laden.", "error");
    return;
  }

  const role = getRole();
  if (role === "admin") {
    document.getElementById("sectionAdmin").style.display = "";
    loadUsers();
  }

  document.getElementById("profileForm").addEventListener("submit", onSaveProfile);
  document.getElementById("newCustomerForm").addEventListener("submit", onCreateCustomer);
  document.getElementById("editUserForm").addEventListener("submit", onSaveEditUser);

  // Close modal on backdrop click
  document.getElementById("editUserModal").addEventListener("click", function(e) {
    if (e.target === this) closeEditModal();
  });
});

// ── Load current user profile ───────────────────────────────────────────────
async function loadProfile() {
  const res = await fetch(`${API}/users/me`, { headers: authHeaders() });
  if (res.status === 401 || res.status === 403) {
    const err = new Error("Nicht autorisiert"); err.status = res.status; throw err;
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "Fehler"); err.status = res.status; throw err;
  }
  const { user } = await res.json();
  sessionStorage.setItem("dmski_role",    user.role || "customer");
  sessionStorage.setItem("dmski_user_id", String(user.id));

  const letter = (user.first_name || user.email || "?")[0].toUpperCase();
  document.getElementById("avatarLetter").textContent = letter;
  document.getElementById("profileName").textContent  =
    [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;
  document.getElementById("profileEmail").textContent = user.email;

  const badge = document.getElementById("profileBadge");
  const labels = { admin: "Administrator", customer: "Fallinhaber", collaborator: "Fallreviewer" };
  badge.textContent = labels[user.role] || user.role;
  badge.className   = `badge-role badge-${user.role || "customer"}`;

  document.getElementById("fieldFirstName").value = user.first_name || "";
  document.getElementById("fieldLastName").value  = user.last_name  || "";
  document.getElementById("fieldEmail").value     = user.email      || "";
  document.getElementById("fieldAddress").value   = user.address    || "";
  document.getElementById("fieldMobile").value    = user.mobile     || "";

  if (user.role === "collaborator") {
    const fnGroup  = document.getElementById("fieldFunctionGroup");
    const fnSelect = document.getElementById("fieldFunction");
    if (fnGroup)  fnGroup.style.display = "";
    if (fnSelect && user.function_label) fnSelect.value = user.function_label;
  }
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

  const fnGroup = document.getElementById("fieldFunctionGroup");
  if (fnGroup && fnGroup.style.display !== "none") {
    body.function_label = document.getElementById("fieldFunction").value || "";
  }

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
  } catch { setMsg(msg, "Netzwerkfehler. Bitte erneut versuchen.", "error"); }
  finally   { if (btn) { btn.disabled = false; btn.textContent = "Speichern"; } }
}

// ── Admin: load all users (Benutzerverwaltung) ──────────────────────────────
async function loadUsers() {
  const el = document.getElementById("customerList");
  try {
    const res  = await fetch(`${API}/users`, { headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { el.innerHTML = `<p class="empty-state">${escHtml(data.error)}</p>`; return; }

    const users = (data.users || []).filter(u => u.role !== "admin");
    if (users.length === 0) {
      el.innerHTML = `<p class="empty-state">Noch keine Benutzer vorhanden.</p>`; return;
    }

    el.innerHTML = users.map(u => {
      const name     = [u.first_name, u.last_name].filter(Boolean).join(" ") || "–";
      const isCollab = u.role === "collaborator";
      const roleLbl  = isCollab ? "Fachperson" : "Kunde";
      const roleColor = isCollab
        ? "background:#e0e7ff;color:#3730a3"
        : "background:#d1fae5;color:#065f46";
      const avatarBg = isCollab
        ? "background:linear-gradient(135deg,#4f46e5,#3730a3);color:#fff"
        : "background:linear-gradient(135deg,#dbeafe,#bfdbfe);color:#1d4ed8";

      return `<div class="customer-card" id="ucard-${u.id}">
        <div class="customer-avatar" style="${avatarBg}">
          ${(u.first_name || u.email || "?")[0].toUpperCase()}
        </div>
        <div class="customer-info">
          <div class="customer-name">${escHtml(name)}</div>
          <div class="customer-email">${escHtml(u.email)}</div>
        </div>
        <span style="${roleColor};padding:.15rem .55rem;border-radius:6px;font-size:.75rem;font-weight:600;white-space:nowrap">${roleLbl}</span>

        <!-- Edit button -->
        <button onclick="openEditModal(${u.id},'${escAttr(u.first_name||'')}','${escAttr(u.last_name||'')}','${escAttr(u.email)}','${escAttr(u.mobile||'')}','${u.role}')"
          style="display:inline-flex;align-items:center;justify-content:center;width:1.9rem;height:1.9rem;border-radius:8px;border:1px solid #93c5fd;background:#eff6ff;color:#1d4ed8;cursor:pointer;transition:background .15s;flex-shrink:0"
          title="Benutzer bearbeiten">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:.85rem;height:.85rem">
            <path d="M11 2l3 3-8 8H3v-3l8-8z"/>
          </svg>
        </button>

        <!-- Delete button -->
        <button onclick="deleteUser(${u.id},'${escAttr(name)}')"
          style="display:inline-flex;align-items:center;justify-content:center;width:1.9rem;height:1.9rem;border-radius:8px;border:1px solid #fca5a5;background:#fff5f5;color:#b91c1c;cursor:pointer;transition:background .15s;flex-shrink:0"
          title="Benutzer löschen">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" style="width:.85rem;height:.85rem">
            <path d="M3 4h10M6 4V3h4v1M5 4v8h6V4"/>
          </svg>
        </button>
      </div>`;
    }).join("");
  } catch {
    el.innerHTML = `<p class="empty-state">Benutzerliste konnte nicht geladen werden.</p>`;
  }
}

// alias for tab "Alle Kunden" button
function loadCustomers() { loadUsers(); }

// ── Delete user ─────────────────────────────────────────────────────────────
async function deleteUser(userId, name) {
  if (!confirm(`Benutzer «${name}» wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`)) return;
  try {
    const res  = await fetch(`${API}/users/${userId}`, { method: "DELETE", headers: authHeaders() });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || "Fehler beim Löschen.", "error"); return; }
    // Remove card from DOM
    document.getElementById(`ucard-${userId}`)?.remove();
    showToast(`✓ Benutzer «${name}» gelöscht.`, "success");
  } catch { showToast("Netzwerkfehler beim Löschen.", "error"); }
}

// ── Edit user modal ─────────────────────────────────────────────────────────
function openEditModal(id, firstName, lastName, email, mobile, role) {
  document.getElementById("editUserId").value    = id;
  document.getElementById("editFirstName").value = firstName;
  document.getElementById("editLastName").value  = lastName;
  document.getElementById("editEmail").value     = email;
  document.getElementById("editMobile").value    = mobile;
  document.getElementById("editRole").value      = role;
  setMsg(document.getElementById("editUserMsg"), "");
  const modal = document.getElementById("editUserModal");
  modal.style.display = "flex";
  // Focus first input
  setTimeout(() => document.getElementById("editFirstName").focus(), 50);
}

function closeEditModal() {
  document.getElementById("editUserModal").style.display = "none";
}

async function onSaveEditUser(e) {
  e.preventDefault();
  const userId = Number(document.getElementById("editUserId").value);
  const msg    = document.getElementById("editUserMsg");
  const btn    = e.target.querySelector("button[type=submit]");
  setMsg(msg, "");
  if (btn) { btn.disabled = true; btn.textContent = "Speichert …"; }

  const body = {
    first_name: document.getElementById("editFirstName").value.trim(),
    last_name:  document.getElementById("editLastName").value.trim(),
    email:      document.getElementById("editEmail").value.trim(),
    mobile:     document.getElementById("editMobile").value.trim(),
    role:       document.getElementById("editRole").value,
  };

  try {
    const res  = await fetch(`${API}/users/${userId}`, {
      method: "PATCH", headers: authHeaders(), body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { setMsg(msg, data.error || "Fehler.", "error"); return; }
    showToast("✓ Benutzer erfolgreich aktualisiert.", "success");
    closeEditModal();
    loadUsers();
  } catch { setMsg(msg, "Netzwerkfehler.", "error"); }
  finally   { if (btn) { btn.disabled = false; btn.textContent = "Speichern"; } }
}

// ── Admin: create new customer ──────────────────────────────────────────────
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
    setMsg(msg, `✓ Benutzer «${escHtml(name)}» erfolgreich erstellt.`, "success");

    pwdBox.style.display = "";
    pwdBox.innerHTML = buildPwdBox(
      `Temporäres Passwort für ${data.user.email}`, data.generatedPassword,
      "⚠️ Dieses Passwort wird nur einmal angezeigt. Bitte sicher an den Kunden weitergeben."
    );
    pwdBox.querySelector(".copy-btn")?.addEventListener("click", function() {
      copyPwd(data.generatedPassword, this);
    });

    e.target.reset();
    loadUsers();
    showAdminTab("list");
  } catch { setMsg(msg, "Netzwerkfehler.", "error"); }
  finally   { if (btn) { btn.disabled = false; btn.textContent = "Kunden erstellen & Passwort generieren"; } }
}

// ── Admin tabs ──────────────────────────────────────────────────────────────
function showAdminTab(tab) {
  document.getElementById("adminListView").style.display = tab === "list" ? "" : "none";
  document.getElementById("adminNewView").style.display  = tab === "new"  ? "" : "none";
  const btnList = document.getElementById("tabListCustomers");
  const btnNew  = document.getElementById("tabNewCustomer");
  if (btnList) btnList.style.opacity = tab === "list" ? "1" : ".55";
  if (btnNew)  btnNew.style.opacity  = tab === "new"  ? "1" : ".55";
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

function escAttr(str) {
  return String(str || "").replace(/'/g, "\\'").replace(/"/g, "&quot;");
}

function copyPwd(pwd, btn) {
  navigator.clipboard.writeText(pwd).then(() => {
    const orig = btn.textContent;
    btn.textContent = "✓ Kopiert";
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
}

window.showAdminTab    = showAdminTab;
window.deleteUser      = deleteUser;
window.openEditModal   = openEditModal;
window.closeEditModal  = closeEditModal;

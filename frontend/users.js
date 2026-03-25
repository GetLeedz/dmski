/* users.js – Benutzerverwaltung */
"use strict";

const _h = String(window.location.hostname || "").toLowerCase();
const _isLocal = _h === "localhost" || _h === "127.0.0.1" || _h.endsWith(".local")
  || /^192\.168\./.test(_h) || /^10\./.test(_h);
const API = _isLocal
  ? "http://localhost:4000"
  : "https://lively-reverence-production-def3.up.railway.app";

const getToken  = () => sessionStorage.getItem("token") || "";
const getRole   = () => sessionStorage.getItem("dmski_role") || "customer";
const getUserId = () => Number(sessionStorage.getItem("dmski_user_id") || 0);
const authHdr   = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` });

// ── State ───────────────────────────────────────────────────────────────────
let allUsers   = [];
let isAdmin    = false;
let myUserId   = 0;
let modalMode  = "add";   // "add" | "edit"
let editTarget = null;    // { userId, linkId }

// ── Boot ────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("copyrightYear").textContent = new Date().getFullYear();

  if (!getToken()) { window.location.replace("/"); return; }

  document.getElementById("logoutBtn").addEventListener("click", () => {
    sessionStorage.removeItem("token");
    sessionStorage.removeItem("currentCaseId");
    window.location.href = "/";
  });
  document.getElementById("userModal").addEventListener("click", e => {
    if (e.target === document.getElementById("userModal")) closeModal();
  });
  document.getElementById("userModalForm").addEventListener("submit", onModalSubmit);
  document.getElementById("newCustomerForm")?.addEventListener("submit", onCreateCustomer);

  try {
    const res = await fetch(`${API}/users/me`, { headers: authHdr() });
    if (res.status === 401 || res.status === 403) { window.location.replace("/"); return; }
    const { user } = await res.json();
    sessionStorage.setItem("dmski_role",    user.role || "customer");
    sessionStorage.setItem("dmski_user_id", String(user.id));
    isAdmin  = user.role === "admin";
    myUserId = user.id;
  } catch { window.location.replace("/"); return; }

  document.getElementById("authGate").style.display  = "none";
  document.getElementById("usersMain").style.display = "";

  if (isAdmin) {
    document.getElementById("roleFilter").style.display = "";
  } else {
    document.getElementById("heroSub").textContent    = "Meine Fachpersonen — anlegen, bearbeiten und löschen";
    document.getElementById("addBtnLabel").textContent = "Fachperson anlegen";
  }

  await loadUsers();
  await loadCasesForModal();
});

// ── Load users ──────────────────────────────────────────────────────────────
async function loadUsers() {
  const el = document.getElementById("userList");
  el.innerHTML = `<div class="u-empty"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg><p>Lade Liste …</p></div>`;

  try {
    let rows = [];
    if (isAdmin) {
      const res  = await fetch(`${API}/users`, { headers: authHdr() });
      const data = await res.json();
      if (!res.ok) { showListError(data.error); return; }
      rows = (data.users || []).filter(u => u.role !== "admin").map(u => ({
        userId:    u.id,
        linkId:    null,
        email:     u.email,
        firstName: u.first_name || "",
        lastName:  u.last_name  || "",
        mobile:    u.mobile     || "",
        role:      u.role,
        fn:        u.function_label || null,
        caseId:    u.case_id        || null,
        caseName:  null,
      }));
    } else {
      const res  = await fetch(`${API}/users/${myUserId}/collaborators`, { headers: authHdr() });
      const data = await res.json();
      if (!res.ok) { showListError(data.error); return; }
      rows = (data.collaborators || []).map(c => ({
        userId:    c.user_id,
        linkId:    c.id,
        email:     c.email,
        firstName: c.first_name || "",
        lastName:  c.last_name  || "",
        mobile:    c.mobile     || "",
        role:      "collaborator",
        fn:        c.function_label || null,
        caseId:    c.case_id        || null,
        caseName:  c.case_name      || null,
      }));
    }
    allUsers = rows;
    renderList(rows);
  } catch { showListError("Netzwerkfehler. Bitte neu laden."); }
}

function showListError(msg) {
  document.getElementById("userList").innerHTML =
    `<div class="u-empty"><p>⚠ ${esc(msg)}</p></div>`;
}

// ── Render ──────────────────────────────────────────────────────────────────
function renderList(rows) {
  const el = document.getElementById("userList");
  if (!rows.length) {
    el.innerHTML = `<div class="u-empty">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
        <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
        <circle cx="9" cy="7" r="4"/>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>
      </svg>
      <p>Keine Benutzer gefunden.</p>
    </div>`;
    return;
  }

  el.innerHTML = rows.map(u => {
    const name    = [u.firstName, u.lastName].filter(Boolean).join(" ") || "–";
    const initial = (u.firstName || u.email || "?")[0].toUpperCase();
    const isCollab = u.role === "collaborator";
    const avCls   = isCollab ? "u-av u-av--f" : "u-av u-av--k";
    const roleLbl = isCollab ? "Fachperson" : "Kunde";
    const roleCls = isCollab ? "badge badge--f" : "badge badge--k";
    const fnBadge = u.fn ? `<span class="badge badge--fn">${esc(u.fn)}</span>` : "";
    const caBadge = u.caseName ? `<span class="badge badge--ca">${esc(u.caseName)}</span>` : "";

    return `<div class="u-card" id="uc-${u.userId}">
      <div class="${avCls}">${esc(initial)}</div>
      <div class="u-info">
        <div class="u-name">${esc(name)}</div>
        <div class="u-email">${esc(u.email)}</div>
      </div>
      ${fnBadge}${caBadge}
      <span class="${roleCls}">${roleLbl}</span>
      <button class="ib ib--edit" onclick="openEditModal(${u.userId})" title="Bearbeiten" type="button">
        <svg viewBox="0 0 24 24" stroke-width="1.9"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>
      </button>
      <button class="ib ib--del" onclick="deleteUser(${u.userId})" title="Löschen" type="button">
        <svg viewBox="0 0 24 24" stroke-width="1.9"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
      </button>
    </div>`;
  }).join("");
}

// ── Filter ───────────────────────────────────────────────────────────────────
function filterList() {
  const q     = (document.getElementById("searchInput").value || "").toLowerCase().trim();
  const role  = (document.getElementById("roleFilter").value  || "").toLowerCase();
  const fnVal = (document.getElementById("fnFilter").value    || "").toLowerCase();

  const filtered = allUsers.filter(u => {
    const name  = [u.firstName, u.lastName, u.email].join(" ").toLowerCase();
    const matchQ    = !q    || name.includes(q);
    const matchRole = !role || u.role === role;
    const matchFn   = !fnVal || (u.fn || "").toLowerCase() === fnVal;
    return matchQ && matchRole && matchFn;
  });
  renderList(filtered);
}

// ── Admin tab switch ─────────────────────────────────────────────────────────
function switchTab(tab) {
  document.getElementById("listPanel").style.display        = tab === "list" ? "" : "none";
  document.getElementById("newCustomerPanel").style.display = tab === "new"  ? "" : "none";
  document.getElementById("tabList").classList.toggle("active", tab === "list");
  document.getElementById("tabNew").classList.toggle("active",  tab === "new");
}

// ── Funktion select helper ────────────────────────────────────────────────────
function setFnChip(val) {
  const sel = document.getElementById("mFunction");
  if (sel) sel.value = val || "";
}

// ── Open ADD modal ──────────────────────────────────────────────────────────
function openAddModal() {
  modalMode  = "add";
  editTarget = null;

  document.getElementById("mUserId").value    = "";
  document.getElementById("mFirstName").value = "";
  document.getElementById("mLastName").value  = "";
  document.getElementById("mEmail").value     = "";
  document.getElementById("mMobile").value    = "";
  setFnChip("");
  document.getElementById("mCase").value = "";

  document.getElementById("mFachSection").style.display = "";
  document.getElementById("mFnGroup").style.display     = "";
  document.getElementById("mCaseGroup").style.display   = "";

  document.getElementById("modalTitle").textContent       = isAdmin ? "Benutzer anlegen" : "Fachperson anlegen";
  document.getElementById("modalSaveBtn").textContent     = "Anlegen";
  document.getElementById("mEmail").removeAttribute("disabled");

  hideModalMsg(); hideModalPwd();
  loadCasesForModal();
  document.getElementById("userModal").classList.add("open");
  setTimeout(() => document.getElementById("mFirstName").focus(), 60);
}

// ── Open EDIT modal ─────────────────────────────────────────────────────────
function openEditModal(userId) {
  // Use loose equality to handle any integer/string type mismatch from onclick attrs
  const u = allUsers.find(x => Number(x.userId) === Number(userId));
  if (!u) { console.warn("openEditModal: user not found", userId, allUsers); return; }
  modalMode  = "edit";
  editTarget = { userId: u.userId, linkId: u.linkId };

  document.getElementById("mUserId").value    = u.userId;
  document.getElementById("mFirstName").value = u.firstName;
  document.getElementById("mLastName").value  = u.lastName;
  document.getElementById("mEmail").value     = u.email;
  document.getElementById("mMobile").value    = u.mobile;
  setFnChip(u.fn || "");
  document.getElementById("mCase").value = u.caseId || "";

  const isCollab = u.role === "collaborator";
  document.getElementById("mFachSection").style.display = isCollab ? "" : "none";
  document.getElementById("mFnGroup").style.display     = isCollab ? "" : "none";
  document.getElementById("mCaseGroup").style.display   = isCollab ? "" : "none";

  const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.email;
  document.getElementById("modalTitle").textContent      = `${name} bearbeiten`;
  document.getElementById("modalSaveBtn").textContent    = "Speichern";
  document.getElementById("mEmail").removeAttribute("disabled");

  hideModalMsg(); hideModalPwd();
  loadCasesForModal();
  document.getElementById("userModal").classList.add("open");
  setTimeout(() => document.getElementById("mFirstName").focus(), 60);
}

function closeModal() {
  document.getElementById("userModal").classList.remove("open");
}

// ── Modal submit ─────────────────────────────────────────────────────────────
async function onModalSubmit(e) {
  e.preventDefault();
  const btn = document.getElementById("modalSaveBtn");
  btn.disabled = true;
  btn.textContent = "Speichert …";
  hideModalMsg(); hideModalPwd();
  try {
    if (modalMode === "add") {
      await doAddUser();
    } else {
      await doEditUser();
    }
  } catch (err) {
    console.error("Modal save error:", err);
    showModalMsg(
      (err instanceof TypeError && err.message.includes("fetch"))
        ? "Netzwerkfehler — bitte Verbindung prüfen und erneut versuchen."
        : (err.message ? `Fehler: ${err.message}` : "Fehler beim Speichern. Bitte erneut versuchen."),
      "error"
    );
  } finally {
    btn.disabled = false;
    btn.textContent = modalMode === "add" ? "Anlegen" : "Speichern";
  }
}

async function doAddUser() {
  const email     = document.getElementById("mEmail").value.trim();
  const firstName = document.getElementById("mFirstName").value.trim() || undefined;
  const lastName  = document.getElementById("mLastName").value.trim()  || undefined;
  const mobile    = document.getElementById("mMobile").value.trim()    || undefined;
  const fnVal     = document.getElementById("mFunction").value         || "";
  const caseId    = document.getElementById("mCase").value             || undefined;

  if (!fnVal) {
    // No function → create as customer
    const body = { email, first_name: firstName, last_name: lastName, mobile };
    const res  = await fetch(`${API}/users/customers`, { method: "POST", headers: authHdr(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { showModalMsg(data.error || "Fehler.", "error"); return; }
    const nm = [data.user?.first_name, data.user?.last_name].filter(Boolean).join(" ") || data.user?.email || email;
    showModalMsg(`✓ Kunde «${esc(nm)}» angelegt.`, "ok");
    if (data.generatedPassword) showModalPwd(data.user?.email || email, data.generatedPassword);
    await loadUsers();
    return;
  }

  // Has function → create as collaborator (Fachperson)
  const body = { email, first_name: firstName, last_name: lastName, function_label: fnVal, case_id: caseId };
  const res  = await fetch(`${API}/users/${myUserId}/collaborators`, {
    method: "POST", headers: authHdr(), body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) { showModalMsg(data.error || "Fehler.", "error"); return; }
  const collab = data.collaborator || {};
  const nm = [collab.first_name, collab.last_name].filter(Boolean).join(" ") || collab.email || email;
  showModalMsg(`✓ Fachperson «${esc(nm)}» angelegt.`, "ok");
  if (data.isNewUser && data.generatedPassword) showModalPwd(collab.email || email, data.generatedPassword);
  await loadUsers();
}

async function doEditUser() {
  const userId = editTarget.userId;
  const fnVal  = document.getElementById("mFunction").value || undefined;

  const body = {
    first_name:     document.getElementById("mFirstName").value.trim() || undefined,
    last_name:      document.getElementById("mLastName").value.trim()  || undefined,
    email:          document.getElementById("mEmail").value.trim(),
    mobile:         document.getElementById("mMobile").value.trim()    || undefined,
    function_label: fnVal,
    case_id:        document.getElementById("mCase").value             || undefined,
  };

  const res  = await fetch(`${API}/users/${userId}`, {
    method: "PATCH", headers: authHdr(), body: JSON.stringify(body)
  });
  const data = await res.json();
  if (!res.ok) { showModalMsg(data.error || "Fehler.", "error"); return; }
  showModalMsg("✓ Gespeichert.", "ok");
  setTimeout(closeModal, 900);
  await loadUsers();
}

// ── Delete ───────────────────────────────────────────────────────────────────
async function deleteUser(userId) {
  const u    = allUsers.find(x => x.userId === userId);
  const name = u ? ([u.firstName, u.lastName].filter(Boolean).join(" ") || u.email) : String(userId);
  if (!confirm(`«${name}» wirklich entfernen? Diese Aktion kann nicht rückgängig gemacht werden.`)) return;

  try {
    if (!isAdmin && u?.linkId) {
      const res  = await fetch(`${API}/users/${myUserId}/collaborators/${u.linkId}`, { method: "DELETE", headers: authHdr() });
      const data = await res.json();
      if (!res.ok) { toast(data.error || "Fehler.", "error"); return; }
    } else {
      const res  = await fetch(`${API}/users/${userId}`, { method: "DELETE", headers: authHdr() });
      const data = await res.json();
      if (!res.ok) { toast(data.error || "Fehler.", "error"); return; }
    }
    document.getElementById(`uc-${userId}`)?.remove();
    allUsers = allUsers.filter(x => x.userId !== userId);
    toast(`✓ «${name}» entfernt.`, "success");
  } catch { toast("Netzwerkfehler.", "error"); }
}

// ── Load cases for modal dropdown ────────────────────────────────────────────
async function loadCasesForModal() {
  const sel = document.getElementById("mCase");
  if (!sel) return;
  const cur = sel.value;
  try {
    const ep  = isAdmin ? `${API}/cases` : `${API}/users/${myUserId}/cases`;
    let res   = await fetch(ep, { headers: authHdr() });
    if (res.status === 404) res = await fetch(`${API}/cases`, { headers: authHdr() });
    if (!res.ok) return;
    const data = await res.json();
    const cases = data.cases || data || [];
    sel.innerHTML = `<option value="">Keinen Fall zuweisen</option>` +
      cases.map(c => `<option value="${esc(String(c.id))}" ${String(c.id) === cur ? "selected" : ""}>${esc(c.case_name || c.title || "Fall #" + c.id)}</option>`).join("");
  } catch { /* no cases available */ }
}

// ── Admin: create customer from panel ───────────────────────────────────────
async function onCreateCustomer(e) {
  e.preventDefault();
  const btn    = e.target.querySelector("button[type=submit]");
  const msg    = document.getElementById("ncMsg");
  const pwdBox = document.getElementById("ncPwdBox");
  msg.style.display = "none"; pwdBox.style.display = "none";

  const body = {
    email:      document.getElementById("ncEmail").value.trim(),
    first_name: document.getElementById("ncFirstName").value.trim() || undefined,
    last_name:  document.getElementById("ncLastName").value.trim()  || undefined,
    mobile:     document.getElementById("ncMobile").value.trim()    || undefined,
    address:    document.getElementById("ncAddress").value.trim()   || undefined,
  };

  btn.disabled = true; btn.textContent = "Erstellt …";
  try {
    const res  = await fetch(`${API}/users/customers`, { method: "POST", headers: authHdr(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { showPanelMsg(msg, data.error || "Fehler.", "error"); return; }
    const nm = [data.user?.first_name, data.user?.last_name].filter(Boolean).join(" ") || data.user?.email || body.email;
    showPanelMsg(msg, `✓ Kunde «${esc(nm)}» erstellt.`, "success");
    if (data.generatedPassword) {
      pwdBox.style.display = "";
      pwdBox.innerHTML = `<div class="pwd-reveal">
        <span style="font-size:.8rem;color:#047857;font-weight:600">Temporäres Passwort:</span>
        <strong>${esc(data.generatedPassword)}</strong>
        <button class="btn-copy" onclick="copyText('${esc(data.generatedPassword)}',this)">Kopieren</button>
      </div>
      <p style="font-size:.75rem;color:#8ba4b0;margin:.4rem 0 0">⚠ Wird nur einmal angezeigt.</p>`;
    }
    e.target.reset();
    await loadUsers();
    switchTab("list");
  } catch { showPanelMsg(msg, "Netzwerkfehler.", "error"); }
  finally   { btn.disabled = false; btn.textContent = "Kunden erstellen & Passwort generieren"; }
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function showModalMsg(text, type) {
  const el = document.getElementById("modalMsg");
  el.textContent   = text;
  el.className     = `msg msg--${type === "success" ? "ok" : type}`;
  el.style.display = "";
}
function hideModalMsg() {
  const el = document.getElementById("modalMsg");
  el.style.display = "none"; el.textContent = "";
}

function showModalPwd(email, pwd) {
  const el = document.getElementById("modalPwdBox");
  el.style.display = "";
  el.innerHTML = `<div class="pwd-box">
    <span style="font-size:.78rem;font-weight:600;color:#065f46;white-space:nowrap">${esc(email)} — Temp. Passwort:</span>
    <strong>${esc(pwd)}</strong>
    <button class="btn-copy" type="button" onclick="copyText('${esc(pwd)}',this)">Kopieren</button>
  </div>
  <p style="font-size:.73rem;color:#8ba4b0;margin:.35rem 0 0">⚠ Wird nur einmal angezeigt — bitte sichern.</p>`;
}
function hideModalPwd() {
  const el = document.getElementById("modalPwdBox");
  el.style.display = "none"; el.innerHTML = "";
}

function showPanelMsg(el, text, type) {
  el.textContent   = text;
  el.className     = `msg msg--${type}`;
  el.style.display = "";
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.textContent;
    btn.textContent = "✓ Kopiert";
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
}

function toast(text, type = "info") {
  const el = document.createElement("div");
  el.textContent = text;
  el.style.cssText = `position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%);
    padding:.65rem 1.2rem;border-radius:8px;font-size:.88rem;font-weight:600;z-index:99999;
    background:${type === "error" ? "#fff5f5" : "#ecfdf5"};
    border:1.5px solid ${type === "error" ? "#fca5a5" : "#6ee7b7"};
    color:${type === "error" ? "#b91c1c" : "#065f46"};
    box-shadow:0 4px 16px rgba(0,0,0,.12);white-space:nowrap`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── Expose to onclick handlers ───────────────────────────────────────────────
window.filterList    = filterList;
window.openAddModal  = openAddModal;
window.openEditModal = openEditModal;
window.closeModal    = closeModal;
window.deleteUser    = deleteUser;
window.copyText      = copyText;
window.switchTab     = switchTab;

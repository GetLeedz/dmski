/* users.js – Benutzerverwaltung */
"use strict";

const API = "https://lively-reverence-production-def3.up.railway.app";

const getToken = () => sessionStorage.getItem("token") || localStorage.getItem("token") || "";
const authHdr = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` });

let allUsers = [];
let isAdmin = false;
let myUserId = 0;
let modalMode = "add";
let currentEditId = null;

function byId(id) { return document.getElementById(id); }

document.addEventListener("DOMContentLoaded", async () => {
  byId("copyrightYear").textContent = new Date().getFullYear();

  if (!getToken()) {
    window.location.replace("/");
    return;
  }

  byId("logoutBtn")?.addEventListener("click", () => {
    sessionStorage.removeItem("token");
    sessionStorage.removeItem("currentCaseId");
    window.location.href = "/";
  });

  byId("userModal")?.addEventListener("click", (e) => {
    if (e.target === byId("userModal")) closeModal();
  });

  byId("userModalForm")?.addEventListener("submit", (e) => {
    e.preventDefault();
    void handleSave();
  });

  try {
    const res = await fetch(`${API}/users/me`, { headers: authHdr(), credentials: "include" });
    if (!res.ok) {
      window.location.replace("/");
      return;
    }
    const data = await res.json();
    const user = data?.user || {};
    isAdmin = user.role === "admin";
    myUserId = Number(user.id || 0);
    sessionStorage.setItem("dmski_role", user.role || "customer");
    sessionStorage.setItem("dmski_user_id", String(myUserId));
  } catch {
    window.location.replace("/");
    return;
  }

  byId("authGate").style.display = "none";
  byId("usersMain").style.display = "";
  if (isAdmin) byId("roleFilter").style.display = "";

  await loadUsers();
  await loadCasesForModal();
});

function normalizeUser(raw, source = "users") {
  let id = 0;
  if (source === "collaborators") {
    id = Number(raw?.user_id || raw?.collaborator_id || raw?.userId || 0);
  } else {
    id = Number(raw?.id || raw?.user_id || raw?.userId || 0);
  }
  const userId = id;
  return {
    id,
    userId,
    linkId: source === "collaborators" ? Number(raw?.id || 0) || null : null,
    email: String(raw?.email || ""),
    firstName: String(raw?.first_name || raw?.firstName || ""),
    lastName: String(raw?.last_name || raw?.lastName || ""),
    mobile: String(raw?.mobile || ""),
    role: String(raw?.role || (source === "collaborators" ? "collaborator" : "customer")),
    fn: String(raw?.function_label || raw?.fn || ""),
    caseId: String(raw?.case_id || raw?.caseId || ""),
    caseName: String(raw?.case_name || raw?.caseName || "")
  };
}

async function loadUsers() {
  const list = byId("userList");
  list.innerHTML = `<div class="u-empty"><p>Lade Benutzerliste …</p></div>`;

  try {
    let rows = [];
    if (isAdmin) {
      const res = await fetch(`${API}/users`, { headers: authHdr(), credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Benutzer konnten nicht geladen werden.");
      rows = (data?.users || [])
        .filter((u) => u.role !== "admin")
        .map((u) => normalizeUser(u, "users"));
    } else {
      const res = await fetch(`${API}/users/${myUserId}/collaborators`, { headers: authHdr(), credentials: "include" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Fachpersonen konnten nicht geladen werden.");
      rows = (data?.collaborators || []).map((c) => normalizeUser(c, "collaborators"));
    }

    allUsers = rows.filter((u) => Number(u.id) > 0);
    renderList(allUsers);
  } catch (err) {
    list.innerHTML = `<div class="u-empty"><p>⚠ ${esc(err?.message || "Fehler beim Laden")}</p></div>`;
  }
}

function renderList(rows) {
  const el = byId("userList");
  if (!rows.length) {
    el.innerHTML = `<div class="u-empty"><p>Keine Benutzer gefunden.</p></div>`;
    return;
  }

  el.innerHTML = rows.map((u) => {
    const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "–";
    const initials = (u.firstName || u.email || "?")[0].toUpperCase();
    const roleClass = u.role === "collaborator" ? "badge badge--f" : "badge badge--k";
    const roleLabel = u.role === "collaborator" ? "Fachperson" : "Kunde";

    return `
      <div class="u-card" id="uc-${u.id}">
        <div class="u-av ${u.role === "collaborator" ? "u-av--f" : "u-av--k"}">${esc(initials)}</div>
        <div class="u-info">
          <div class="u-name">${esc(name)}</div>
          <div class="u-email">${esc(u.email)}</div>
        </div>
        ${u.fn ? `<span class="badge badge--fn">${esc(u.fn)}</span>` : ""}
        <span class="${roleClass}">${roleLabel}</span>
        <button class="ib ib--edit" onclick="openEditModal('${u.userId}')" title="Bearbeiten" type="button">
          <svg viewBox="0 0 24 24" stroke-width="1.9"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>
        </button>
        <button class="ib ib--del" onclick="deleteUser('${u.userId}')" title="Löschen" type="button">
          <svg viewBox="0 0 24 24" stroke-width="1.9"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
        </button>
      </div>
    `;
  }).join("");
}

function filterList() {
  const q = String(byId("searchInput")?.value || "").toLowerCase().trim();
  const role = String(byId("roleFilter")?.value || "").toLowerCase().trim();
  const fn = String(byId("fnFilter")?.value || "").toLowerCase().trim();

  const filtered = allUsers.filter((u) => {
    const hay = `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase();
    const roleOk = !role || String(u.role || "").toLowerCase() === role;
    const fnOk = !fn || String(u.fn || "").toLowerCase() === fn;
    return (!q || hay.includes(q)) && roleOk && fnOk;
  });

  renderList(filtered);
}

function setField(primaryId, fallbackId, value) {
  const el = byId(primaryId) || byId(fallbackId);
  if (el) el.value = value ?? "";
}

function openAddModal() {
  modalMode = "add";
  currentEditId = null;

  setField("edit-vorname", "mFirstName", "");
  setField("edit-nachname", "mLastName", "");
  setField("edit-email", "mEmail", "");
  setField("edit-mobile", "mMobile", "");
  setField("edit-funktion", "mFunction", "");
  setField("edit-case", "mCase", "");
  if (byId("edit-id")) byId("edit-id").value = "";
  if (byId("mUserId")) byId("mUserId").value = "";

  byId("modalTitle").textContent = isAdmin ? "Benutzer anlegen" : "Fachperson anlegen";
  byId("modalSaveBtn").textContent = "Anlegen";
  hideModalMsg();
  byId("userModal").classList.add("open");
}

function openEditModal(selectedId) {
  console.log("Versuche User zu finden mit ID:", selectedId);

  const user = allUsers.find((u) => String(u.id) === String(selectedId));
  if (!user) {
    console.error("User nicht gefunden für ID:", selectedId, "allUsers:", allUsers);
    showModalMsg("Benutzer konnte nicht geladen werden.", "error");
    byId("userModal").classList.add("open");
    return;
  }

  modalMode = "edit";
  currentEditId = String(selectedId);

  // Explizite Befüllung wie gefordert
  const editVorname = byId("edit-vorname") || byId("mFirstName");
  const editNachname = byId("edit-nachname") || byId("mLastName");
  const editEmail = byId("edit-email") || byId("mEmail");
  const editMobile = byId("edit-mobile") || byId("mMobile");
  const editFunktion = byId("edit-funktion") || byId("edit-function") || byId("mFunction");

  if (editVorname) editVorname.value = user.firstName || "";
  if (editNachname) editNachname.value = user.lastName || "";
  if (editEmail) editEmail.value = user.email || "";
  if (editMobile) editMobile.value = user.mobile || "";
  if (editFunktion) editFunktion.value = user.fn || "";

  setField("edit-case", "mCase", user.caseId || "");
  if (byId("edit-id")) byId("edit-id").value = String(user.id);
  if (byId("mUserId")) byId("mUserId").value = String(user.id);

  byId("modalTitle").textContent = "Benutzer editieren";
  byId("modalSaveBtn").textContent = "Speichern";
  hideModalMsg();
  byId("userModal").classList.add("open");
}

function closeModal() {
  byId("userModal").classList.remove("open");
}

async function handleSave() {
  const btn = byId("modalSaveBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Speichert …";
  }

  try {
    if (modalMode === "edit") {
      await saveEditUser();
    } else {
      await saveNewUser();
    }
  } catch (err) {
    showModalMsg(err?.message || "Fehler beim Speichern.", "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = modalMode === "edit" ? "Speichern" : "Anlegen";
    }
  }
}

function buildUserPayload() {
  return {
    first_name: String((byId("edit-vorname") || byId("mFirstName"))?.value || "").trim() || undefined,
    last_name: String((byId("edit-nachname") || byId("mLastName"))?.value || "").trim() || undefined,
    email: String((byId("edit-email") || byId("mEmail"))?.value || "").trim(),
    mobile: String((byId("edit-mobile") || byId("mMobile"))?.value || "").trim() || undefined,
    function_label: String((byId("edit-funktion") || byId("edit-function") || byId("mFunction"))?.value || "").trim() || undefined,
    case_id: String((byId("edit-case") || byId("mCase"))?.value || "").trim() || undefined
  };
}

async function saveEditUser() {
  if (!currentEditId) {
    throw new Error("ID undefined: kein Benutzer im Edit-Modus ausgewählt.");
  }

  const payload = buildUserPayload();

  const res = await fetch(`${API}/users/${currentEditId}`, {
    method: "PATCH",
    headers: authHdr(),
    credentials: "include",
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || "Benutzer konnte nicht aktualisiert werden.");
  }

  showModalMsg("✓ Änderungen gespeichert.", "ok");
  await loadUsers();
  setTimeout(() => closeModal(), 700);
}

async function saveNewUser() {
  const payload = buildUserPayload();
  if (!payload.email) {
    throw new Error("E-Mail ist erforderlich.");
  }

  const fnVal = payload.function_label || "";
  let res;

  if (fnVal) {
    res = await fetch(`${API}/users/${myUserId}/collaborators`, {
      method: "POST",
      headers: authHdr(),
      credentials: "include",
      body: JSON.stringify(payload)
    });
  } else {
    res = await fetch(`${API}/users/customers`, {
      method: "POST",
      headers: authHdr(),
      credentials: "include",
      body: JSON.stringify(payload)
    });
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || "Benutzer konnte nicht angelegt werden.");
  }

  showModalMsg("✓ Benutzer angelegt.", "ok");
  await loadUsers();
  setTimeout(() => closeModal(), 700);
}

async function deleteUser(userId) {
  const uid = Number(userId);
  if (!uid) return;

  const user = allUsers.find((u) => Number(u.id) === uid);
  const name = user ? [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email : String(uid);
  if (!confirm(`«${name}» wirklich entfernen?`)) return;

  try {
    let res;
    if (!isAdmin && user?.linkId) {
      res = await fetch(`${API}/users/${myUserId}/collaborators/${user.linkId}`, {
        method: "DELETE",
        headers: authHdr(),
        credentials: "include"
      });
    } else {
      res = await fetch(`${API}/users/${uid}`, {
        method: "DELETE",
        headers: authHdr(),
        credentials: "include"
      });
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || "Löschen fehlgeschlagen.");

    allUsers = allUsers.filter((u) => Number(u.id) !== uid);
    renderList(allUsers);
  } catch (err) {
    alert(err?.message || "Benutzer konnte nicht gelöscht werden.");
  }
}

async function loadCasesForModal() {
  const sel = byId("mCase");
  if (!sel) return;

  const current = sel.value;
  try {
    let res = await fetch(isAdmin ? `${API}/cases` : `${API}/users/${myUserId}/cases`, { headers: authHdr(), credentials: "include" });
    if (!res.ok) res = await fetch(`${API}/cases`, { headers: authHdr(), credentials: "include" });
    if (!res.ok) return;

    const data = await res.json().catch(() => ({}));
    const cases = data?.cases || data || [];
    sel.innerHTML = `<option value="">Keinen Fall zuweisen</option>`
      + cases.map((c) => `<option value="${esc(c.id)}" ${String(c.id) === String(current) ? "selected" : ""}>${esc(c.case_name || c.title || `Fall #${c.id}`)}</option>`).join("");
  } catch {
    // optional
  }
}

function showModalMsg(text, type = "ok") {
  const el = byId("modalMsg");
  if (!el) return;
  el.textContent = text;
  el.className = `msg ${type === "ok" || type === "success" ? "msg--ok" : "msg--err"}`;
  el.style.display = "";
}

function hideModalMsg() {
  const el = byId("modalMsg");
  if (!el) return;
  el.textContent = "";
  el.style.display = "none";
}

function switchTab(tab) {
  byId("listPanel")?.style && (byId("listPanel").style.display = tab === "list" ? "" : "none");
  byId("newCustomerPanel")?.style && (byId("newCustomerPanel").style.display = tab === "new" ? "" : "none");
  byId("tabList")?.classList.toggle("active", tab === "list");
  byId("tabNew")?.classList.toggle("active", tab === "new");
}

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

window.filterList = filterList;
window.openAddModal = openAddModal;
window.openEditModal = openEditModal;
window.closeModal = closeModal;
window.handleSave = handleSave;
window.deleteUser = deleteUser;
window.switchTab = switchTab;

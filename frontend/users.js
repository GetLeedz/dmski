/* users.js – Benutzerverwaltung */
"use strict";

const BASE_URL = "https://lively-reverence-production-def3.up.railway.app/api/users";
const API = "https://lively-reverence-production-def3.up.railway.app/api";

// Holt das Token aus dem Speicher – Wichtig für die Authentifizierung
const getToken = () => sessionStorage.getItem("token") || localStorage.getItem("token") || "";

// Erstellt den Header für die API-Anfragen
const authHdr = () => {
    const token = getToken();
    return { 
        "Content-Type": "application/json", 
        "Authorization": token ? `Bearer ${token}` : "" 
    };
};

let allUsers = [];
let isAdmin = false;
let myUserId = 0;
let modalMode = "add";
let currentEditId = null;

function byId(id) { return document.getElementById(id); }

document.addEventListener("DOMContentLoaded", async () => {
    const yearEl = byId("copyrightYear");
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    // 1. Sofort-Check: Haben wir überhaupt ein Token?
    const token = getToken();
    if (!token) {
        console.warn("Kein Token vorhanden. Umleitung zum Login.");
        window.location.replace("/");
        return;
    }

    // Event Listeners für Logout und Modal
    byId("logoutBtn")?.addEventListener("click", () => {
        sessionStorage.clear();
        localStorage.clear();
        window.location.href = "/";
    });

    byId("userModal")?.addEventListener("click", (e) => {
        if (e.target === byId("userModal")) closeModal();
    });

    byId("userModalForm")?.addEventListener("submit", (e) => {
        e.preventDefault();
        void handleSave();
    });

    // 2. Sitzung beim Server prüfen
    try {
        console.log("Prüfe Sitzung bei /me...");
        const res = await fetch(`${BASE_URL}/me`, { 
            headers: authHdr(), 
            credentials: "include" 
        });

        if (!res.ok) {
            console.error("Sitzung ungültig (Server-Antwort nicht OK)");
            window.location.replace("/");
            return;
        }
        
        const data = await res.json();
        // Erkennt sowohl { user: {...} } als auch das direkte User-Objekt
        const user = data?.user || data;
        
        if (!user || !user.id) {
            throw new Error("Keine Benutzerdaten in der Antwort gefunden.");
        }

        isAdmin = (user.role === "admin");
        myUserId = user.id;
        
        sessionStorage.setItem("dmski_role", user.role || "customer");
        sessionStorage.setItem("dmski_user_id", String(myUserId));

        // 3. Erfolg: UI anzeigen
        if (byId("authGate")) byId("authGate").style.display = "none";
        if (byId("usersMain")) byId("usersMain").style.display = "block";
        if (isAdmin && byId("roleFilter")) byId("roleFilter").style.display = "inline-block";
        // Anlegen-Button nur für Admins
        if (!isAdmin && byId("addBtnLabel")) byId("addBtnLabel").closest("button").style.display = "none";

        // Daten laden
        await loadUsers();
        await loadCasesForModal();

    } catch (err) {
        console.error("Kritischer Fehler im Auth-Check:", err);
        // Nur umleiten, wenn es wirklich ein Auth-Fehler ist, nicht bei Netzwerk-Glitch
        if (err.message.includes("Unauthorized") || err.message.includes("401")) {
            window.location.replace("/");
        }
    }
});

// --- DATEN LADEN & NORMALISIEREN ---

function normalizeUser(raw) {
    return {
        id: raw.id,
        email: String(raw.email || ""),
        salutation: String(raw.salutation || ""),
        academicTitle: String(raw.academic_title || ""),
        firstName: String(raw.first_name || ""),
        lastName: String(raw.last_name || ""),
        mobile: String(raw.mobile || ""),
        role: String(raw.role || "collaborator"),
        fn: String(raw.function_label || ""),
        caseId: String(raw.case_id || ""),
        caseName: String(raw.case_name || ""),
        invitedAt: raw.invited_at || null,
        lastLoginAt: raw.last_login_at || null,
        loginCount: raw.login_count || 0,
        deletedAt: raw.deleted_at || null
    };
}

function formatDate(isoStr) {
    if (!isoStr) return null;
    const d = new Date(isoStr);
    return d.toLocaleDateString("de-CH", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

async function loadUsers() {
    const list = byId("userList");
    if (!list) return;
    list.innerHTML = `<div class="u-empty"><p>Lade Benutzerliste …</p></div>`;

    try {
        const url = isAdmin ? BASE_URL : `${BASE_URL}/${myUserId}/users`;
        const res = await fetch(url, { headers: authHdr(), credentials: "include" });
        const data = await res.json();
        
        if (!res.ok) throw new Error(data?.error || "Fehler beim Laden");

        let rows = (data?.users || data || []).filter(u => u.role !== 'admin');
        // Non-admin: only show self + team on own cases (frontend safety filter)
        if (!isAdmin) {
          const myCaseId = rows.find(u => u.id === myUserId)?.case_id;
          rows = rows.filter(u => u.id === myUserId || (myCaseId && u.case_id === myCaseId));
        }
        allUsers = rows.map(u => normalizeUser(u));
        renderList(allUsers);
    } catch (err) {
        list.innerHTML = `<div class="u-empty"><p>⚠ ${esc(err.message)}</p></div>`;
    }
}

// --- RENDERING ---

function renderList(rows) {
    const el = byId("userList");
    if (!el) return;
    if (!rows.length) {
        el.innerHTML = `<div class="u-empty"><p>Keine Benutzer gefunden.</p></div>`;
        return;
    }

    const svgView = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    const svgInvite = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
    const svgEdit = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>`;
    const svgDel = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:15px;height:15px" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`;

    const tableRows = rows.map((u) => {
        const isDeleted = !!u.deletedAt;
        const name = [u.academicTitle, u.firstName, u.lastName].filter(Boolean).join(" ") || "–";
        const roleLabel = u.role === "collaborator" ? "Teammitglied" : "Fallinhaber";
        const roleClass = u.role === "collaborator" ? "badge badge--team" : "badge badge--kunde";
        const caseName = u.caseId ? esc(u.caseName || u.caseId) : "–";
        const fn = u.fn ? esc(u.fn) : "–";
        const lastLogin = isDeleted
            ? `<span class="badge badge--deleted" title="Konto gelöscht am ${esc(formatDate(u.deletedAt))}">Gelöscht · ${esc(formatDate(u.deletedAt))}</span>`
            : (u.lastLoginAt ? formatDate(u.lastLoginAt) : "–");
        const logins = u.loginCount || 0;

        let actions = `<button class="ib ib--view" onclick="openProfileView('${u.id}')" title="Profil">${svgView}</button>`;
        if (isAdmin && !isDeleted) {
            actions += `<button class="ib ib--invite" onclick="sendInvite('${u.id}')" title="Einladen">${svgInvite}</button>`;
            actions += `<button class="ib ib--edit" onclick="openEditModal('${u.id}')" title="Bearbeiten">${svgEdit}</button>`;
            actions += `<button class="ib ib--del" onclick="deleteUser('${u.id}')" title="Löschen">${svgDel}</button>`;
        }

        return `<tr id="uc-${u.id}"${isDeleted ? ' class="u-row--deleted"' : ""}>
            <td><strong>${esc(name)}</strong></td>
            <td>${esc(u.email)}</td>
            <td><span class="${roleClass}">${roleLabel}</span></td>
            <td>${fn}</td>
            <td>${caseName}</td>
            <td>${lastLogin}</td>
            <td style="text-align:center">${logins}</td>
            <td><div class="u-actions">${actions}</div></td>
        </tr>`;
    }).join("");

    el.innerHTML = `
        <table class="u-table">
            <thead>
                <tr>
                    <th>Name</th>
                    <th>E-Mail</th>
                    <th>Rolle</th>
                    <th>Funktion</th>
                    <th>Fall</th>
                    <th>Letzter Login</th>
                    <th>Logins</th>
                    <th>Aktionen</th>
                </tr>
            </thead>
            <tbody>${tableRows}</tbody>
        </table>`;
}

// --- AKTIONEN ---

const CONFIRM_ICONS = {
    send: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>'
};

function showConfirm(text, onOk, opts = {}) {
    const { title = "Bestätigung", okText = "OK", icon = "send", danger = false } = opts;
    const modal = byId("confirmModal");
    byId("confirmTitle").textContent = title;
    byId("confirmText").textContent = text;
    byId("confirmIcon").innerHTML = CONFIRM_ICONS[icon] || CONFIRM_ICONS.send;
    byId("confirmIcon").style.background = danger
        ? "linear-gradient(135deg,#c8342b,#a02620)"
        : "linear-gradient(135deg,#1A2B3C,#1A2B3C)";

    const okBtn = byId("confirmOkBtn");
    okBtn.textContent = okText;
    okBtn.classList.toggle("btn-danger", danger);

    modal.classList.add("open");

    const cancelBtn = byId("confirmCancelBtn");

    // Clone and replace buttons to remove ALL previous event listeners.
    // This prevents stacked handlers from multiple showConfirm() calls.
    const freshOk = okBtn.cloneNode(true);
    const freshCancel = cancelBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(freshOk, okBtn);
    cancelBtn.parentNode.replaceChild(freshCancel, cancelBtn);

    function cleanup() {
        modal.classList.remove("open");
    }

    freshOk.addEventListener("click", () => { cleanup(); onOk(); });
    freshCancel.addEventListener("click", cleanup);
}

async function sendInvite(targetUserId) {
    // Check if user has password set (client-side hint)
    const user = allUsers.find(u => String(u.id) === String(targetUserId));
    if (user && !user.fn) {
        showToast("Bitte wählen Sie zuerst eine Funktion für diesen Benutzer.", true);
        return;
    }

    showConfirm(
        "Einladungs-E-Mail jetzt an diesen Benutzer senden?",
        async () => {
            const okBtn = byId("confirmOkBtn");
            if (okBtn) { okBtn.disabled = true; okBtn.textContent = "Sendet …"; }

            try {
                const res = await fetch(`${BASE_URL}/${myUserId}/users/${targetUserId}/send-invite`, {
                    method: "POST", headers: authHdr(), credentials: "include"
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.error || "Versand fehlgeschlagen");
                showToast("✓ Einladung erfolgreich versendet.");
            } catch (err) {
                showToast("Fehler: " + err.message, true);
            } finally {
                if (okBtn) { okBtn.disabled = false; okBtn.textContent = "Senden"; }
            }
        },
        { title: "Einladung senden", okText: "Senden", icon: "send" }
    );
}

function showToast(text, isError = false) {
    let el = byId("dmskiToast");
    if (!el) {
        el = document.createElement("div");
        el.id = "dmskiToast";
        el.style.cssText = [
            "position:fixed;bottom:1.5rem;left:50%;transform:translateX(-50%)",
            "padding:.65rem 1.4rem;border-radius:12px;font-size:.875rem;font-weight:600",
            "box-shadow:0 4px 20px rgba(0,0,0,.15);z-index:99999",
            "transition:opacity .3s;pointer-events:none"
        ].join(";");
        document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.background = isError ? "#fee2e2" : "#d1fae5";
    el.style.color = isError ? "#b91c1c" : "#065f46";
    el.style.opacity = "1";
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.style.opacity = "0"; }, 3000);
}

function showModalMsg(text, type) {
    const el = byId("modalMsg");
    if (!el) return;
    el.textContent = text;
    el.className = "msg" + (type ? " msg--" + type : "");
    el.style.display = text ? "" : "none";
}

async function handleSave() {
    const password = (byId("edit-password")?.value || "").trim();
    const isAdd = modalMode === "add";

    showModalMsg("", "");

    if (isAdd && !password) {
        showModalMsg("Bitte zuerst ein Passwort generieren (Würfel-Icon).", "err");
        return;
    }

    const funktionValue = byId("edit-funktion").value.trim();
    const caseValue = byId("edit-case").value || null;
    const beziehung = (document.querySelector('input[name="edit-beziehung"]:checked') || {}).value || "customer";
    const isKunde = beziehung === "customer";

    // Fall zuweisen ist mandatory für Team, nicht für Kunden
    if (!isKunde && !caseValue) {
        showModalMsg("Team-Mitglieder müssen einem Fall zugewiesen werden.", "err");
        return;
    }

    const payload = {
        salutation: (document.querySelector('input[name="edit-anrede"]:checked') || {}).value || "",
        academic_title: byId("edit-titel").value,
        first_name: byId("edit-vorname").value.trim(),
        last_name: byId("edit-nachname").value.trim(),
        email: byId("edit-email").value.trim(),
        mobile: byId("edit-mobile").value.trim(),
        role: beziehung,
        function_label: funktionValue,
        case_id: isKunde ? null : caseValue,
    };
    if (password) payload.password = password;

    const btn = byId("modalSaveBtn");
    if (btn) { btn.disabled = true; btn.textContent = isAdd ? "Anlegt …" : "Speichert …"; }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    try {
        const method = isAdd ? "POST" : "PATCH";
        const url = isAdd ? `${BASE_URL}/${myUserId}/users` : `${BASE_URL}/${currentEditId}`;

        const res = await fetch(url, {
            method,
            headers: authHdr(),
            credentials: "include",
            body: JSON.stringify(payload),
            signal: controller.signal,
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Speichern fehlgeschlagen.");

        // Immediately update local data so the list reflects changes
        // even if the subsequent loadUsers() uses a cached response.
        if (!isAdd && currentEditId && data.user) {
            const idx = allUsers.findIndex(u => u.id === currentEditId);
            if (idx >= 0) {
                allUsers[idx] = normalizeUser({ ...allUsers[idx], ...data.user, ...payload });
                renderList(allUsers);
            }
        }

        await loadUsers();
        closeModal();
    } catch (err) {
        const msg = err.name === "AbortError"
            ? "Zeitüberschreitung – Server antwortet nicht. Bitte erneut versuchen."
            : err.message;
        showModalMsg(msg, "err");
    } finally {
        clearTimeout(timeout);
        if (btn) { btn.disabled = false; btn.textContent = isAdd ? "Anlegen" : "Änderungen speichern"; }
    }
}

async function deleteUser(id) {
    showConfirm(
        "Benutzer wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.",
        async () => {
            const okBtn = byId("confirmOkBtn");
            if (okBtn) { okBtn.textContent = "Löscht …"; okBtn.disabled = true; }
            try {
                const res = await fetch(`${BASE_URL}/${id}`, {
                    method: "DELETE", headers: authHdr(), credentials: "include"
                });
                if (!res.ok) throw new Error("Löschen fehlgeschlagen");
                await loadUsers();
                showToast("Benutzer wurde gelöscht.");
            } catch (err) {
                showToast(err.message, true);
            } finally {
                if (okBtn) { okBtn.textContent = "Löschen"; okBtn.disabled = false; }
            }
        },
        { title: "Benutzer löschen", okText: "Löschen", icon: "trash", danger: true }
    );
}

// --- MODAL & FILTER ---

function openEditModal(id) {
    const u = allUsers.find(user => String(user.id) === String(id));
    if (!u) return;

    modalMode = "edit";
    currentEditId = id;
    document.querySelectorAll('input[name="edit-anrede"]').forEach(r => { r.checked = r.value === (u.salutation || ""); });
    document.querySelectorAll('input[name="edit-beziehung"]').forEach(r => { r.checked = r.value === (u.role || "customer"); });
    byId("edit-titel").value = u.academicTitle || "";
    byId("edit-vorname").value = u.firstName;
    byId("edit-nachname").value = u.lastName;
    byId("edit-email").value = u.email;
    byId("edit-mobile").value = u.mobile;
    byId("edit-funktion").value = u.fn;
    byId("edit-case").value = u.caseId;

    // Passwort-Feld leeren + Hint anpassen
    const pwdInput = byId("edit-password");
    if (pwdInput) { pwdInput.value = ""; pwdInput.type = "password"; }
    if (byId("eyeIcon")) byId("eyeIcon").style.display = "";
    if (byId("eyeOffIcon")) byId("eyeOffIcon").style.display = "none";
    if (byId("pwdReq")) byId("pwdReq").style.display = "none";
    if (byId("pwdHint")) byId("pwdHint").textContent = "Leer lassen, um das Passwort nicht zu ändern.";

    byId("modalTitle").textContent = "Benutzer bearbeiten";
    byId("modalSaveBtn").textContent = "Änderungen speichern";
    byId("userModal").classList.add("open");
    toggleCaseGroup();
}

function openAddModal() {
    modalMode = "add";
    byId("userModalForm").reset();

    // Passwort-Feld zurücksetzen
    const pwdInput = byId("edit-password");
    if (pwdInput) { pwdInput.value = ""; pwdInput.type = "password"; }
    if (byId("eyeIcon")) byId("eyeIcon").style.display = "";
    if (byId("eyeOffIcon")) byId("eyeOffIcon").style.display = "none";
    if (byId("pwdReq")) byId("pwdReq").style.display = "";
    if (byId("pwdHint")) byId("pwdHint").textContent = "Pflichtfeld – Klicken Sie auf den Würfel, um ein sicheres Passwort zu generieren.";

    byId("modalTitle").textContent = "Neuen Benutzer anlegen";
    byId("modalSaveBtn").textContent = "Anlegen";
    byId("userModal").classList.add("open");
    toggleCaseGroup();
}

function toggleCaseGroup() {
    const beziehung = (document.querySelector('input[name="edit-beziehung"]:checked') || {}).value || "";
    const caseGroup = byId("mCaseGroup");
    if (!caseGroup) return;
    caseGroup.style.display = beziehung === "customer" ? "none" : "";
}

// Toggle Fall zuweisen on Beziehung change
document.querySelectorAll('input[name="edit-beziehung"]').forEach(r => {
    r.addEventListener("change", toggleCaseGroup);
});

function openProfileView(id) {
    const u = allUsers.find(user => String(user.id) === String(id));
    if (!u) return;

    const name = [u.academicTitle, u.firstName, u.lastName].filter(Boolean).join(" ") || "–";
    const initials = (u.firstName || u.email || "?")[0].toUpperCase();
    const sal = u.salutation || "";
    const roleLabel = u.role === "collaborator" ? "Teammitglied" : "Fallinhaber";
    const caseName = u.caseId ? (allCases.find(c => String(c.id) === String(u.caseId))?.name || u.caseId) : "–";

    // Build profile view modal
    let modal = byId("profileViewModal");
    if (!modal) {
        modal = document.createElement("div");
        modal.id = "profileViewModal";
        modal.className = "pv-overlay";
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="pv-card">
            <button class="pv-close" onclick="closeProfileView()">&times;</button>
            <div class="pv-header">
                <div class="pv-avatar ${u.role === "collaborator" ? "u-av--f" : "u-av--k"}">${esc(initials)}</div>
                <div>
                    <h3 class="pv-name">${sal ? esc(sal) + " " : ""}${esc(name)}</h3>
                    <p class="pv-email">${esc(u.email)}</p>
                </div>
            </div>
            <div class="pv-grid">
                <div class="pv-field"><span class="pv-label">Anrede</span><span class="pv-value">${esc(sal || "–")}</span></div>
                <div class="pv-field"><span class="pv-label">Titel</span><span class="pv-value">${esc(u.academicTitle || "–")}</span></div>
                <div class="pv-field"><span class="pv-label">Vorname</span><span class="pv-value">${esc(u.firstName || "–")}</span></div>
                <div class="pv-field"><span class="pv-label">Nachname</span><span class="pv-value">${esc(u.lastName || "–")}</span></div>
                <div class="pv-field"><span class="pv-label">E-Mail</span><span class="pv-value">${esc(u.email)}</span></div>
                <div class="pv-field"><span class="pv-label">Telefon</span><span class="pv-value">${esc(u.mobile || "–")}</span></div>
                <div class="pv-field"><span class="pv-label">Funktion</span><span class="pv-value">${u.fn ? `<span class="badge badge--fn">${esc(u.fn)}</span>` : "–"}</span></div>
                <div class="pv-field"><span class="pv-label">Beziehung</span><span class="pv-value"><span class="badge ${u.role === "collaborator" ? "badge--team" : "badge--kunde"}">${esc(roleLabel)}</span></span></div>
                <div class="pv-field pv-full"><span class="pv-label">Zugewiesener Fall</span><span class="pv-value">${esc(caseName)}</span></div>
                ${isAdmin ? `
                <div class="pv-field"><span class="pv-label">Eingeladen am</span><span class="pv-value">${u.invitedAt ? esc(formatDate(u.invitedAt)) : "Noch nicht eingeladen"}</span></div>
                <div class="pv-field"><span class="pv-label">Letzter Login</span><span class="pv-value">${u.lastLoginAt ? esc(formatDate(u.lastLoginAt)) : "Noch nie eingeloggt"}</span></div>
                <div class="pv-field"><span class="pv-label">Anzahl Logins</span><span class="pv-value">${u.loginCount || 0}</span></div>
                ` : ""}
            </div>
        </div>`;
    modal.classList.add("open");
    modal.addEventListener("click", (e) => { if (e.target === modal) closeProfileView(); });
}

function closeProfileView() {
    const modal = byId("profileViewModal");
    if (modal) modal.classList.remove("open");
}

function closeModal() {
    byId("userModal").classList.remove("open");
    showModalMsg("", "");
}

// Sauberer HTML-Escaper
function esc(v) {
    return String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

let allCases = [];
async function loadCasesForModal() {
    const sel = byId("edit-case");
    if (!sel) return;
    try {
        const res = await fetch(`${API}/cases`, { headers: authHdr(), credentials: "include" });
        const data = await res.json();
        allCases = (data.cases || data || []).map(c => ({ id: String(c.id), name: c.case_name || c.title || String(c.id) }));
        sel.innerHTML = `<option value="">Keinem Fall zugewiesen</option>` +
            allCases.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join("");
    } catch (e) { console.error("Cases load error", e); }
}

// ── Passwort-Generator ───────────────────────────────────────────────────────

function generatePassword() {
    const upper   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const lower   = 'abcdefghjkmnpqrstuvwxyz';
    const digits  = '23456789';
    const special = '!@#$%&*+?';
    const all = upper + lower + digits + special;
    // Mindestens 2 aus jeder Zeichenklasse für Policy-Konformität
    const pool = [
        upper[Math.floor(Math.random() * upper.length)],
        upper[Math.floor(Math.random() * upper.length)],
        lower[Math.floor(Math.random() * lower.length)],
        lower[Math.floor(Math.random() * lower.length)],
        digits[Math.floor(Math.random() * digits.length)],
        digits[Math.floor(Math.random() * digits.length)],
        special[Math.floor(Math.random() * special.length)],
        special[Math.floor(Math.random() * special.length)],
        all[Math.floor(Math.random() * all.length)],
        all[Math.floor(Math.random() * all.length)],
    ];
    // Fisher-Yates Shuffle
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool.join('');
}

function generateAndFillPassword() {
    const pwd = generatePassword();
    const input = byId("edit-password");
    if (!input) return;
    input.value = pwd;
    input.type = "text";
    byId("pwdEyeBtn")?.classList.add("is-visible");
}

function togglePwdVisibility() {
    const input = byId("edit-password");
    const btn = byId("pwdEyeBtn");
    if (!input) return;
    const isHidden = input.type === "password";
    input.type = isHidden ? "text" : "password";
    btn?.classList.toggle("is-visible", isHidden);
}

// Global verfügbar machen für HTML-Attribut-Events
window.sendInvite = sendInvite;
window.openEditModal = openEditModal;
window.openAddModal = openAddModal;
window.closeModal = closeModal;
window.deleteUser = deleteUser;
window.generateAndFillPassword = generateAndFillPassword;
window.togglePwdVisibility = togglePwdVisibility;
window.showToast = showToast;
window.filterList = () => {
    const q = byId("searchInput").value.toLowerCase();
    const fnFilter = byId("fnFilter")?.value.toLowerCase() || "";
    const roleFilter = byId("roleFilter")?.value.toLowerCase() || "";
    
    renderList(allUsers.filter(u => {
        const matchesSearch = `${u.firstName} ${u.lastName} ${u.email}`.toLowerCase().includes(q);
        const matchesFn = (u.fn || "").toLowerCase().includes(fnFilter);
        const matchesRole = roleFilter ? (u.role.toLowerCase() === roleFilter) : true;
        return matchesSearch && matchesFn && matchesRole;
    }));
};
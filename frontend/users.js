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
        firstName: String(raw.first_name || ""),
        lastName: String(raw.last_name || ""),
        mobile: String(raw.mobile || ""),
        role: String(raw.role || "collaborator"),
        fn: String(raw.function_label || ""),
        caseId: String(raw.case_id || ""),
        caseName: String(raw.case_name || "")
    };
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

        const rows = (data?.users || data || []).filter(u => u.role !== 'admin');
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

    el.innerHTML = rows.map((u) => {
        const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || "–";
        const initials = (u.firstName || u.email || "?")[0].toUpperCase();
        const roleClass = u.role === "collaborator" ? "badge badge--f" : "badge badge--k";
        const roleLabel = u.role === "collaborator" ? "Fachperson" : "Kunde";

        const adminActions = isAdmin ? `
            <button class="ib ib--invite" onclick="sendInvite('${u.id}')" title="Einladung senden">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:16px;height:16px;" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                </svg>
            </button>
            <button class="ib ib--edit" onclick="openEditModal('${u.id}')" title="Bearbeiten">
                <svg viewBox="0 0 24 24" stroke-width="2" style="width:16px;height:16px;" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/>
                </svg>
            </button>
            <button class="ib ib--del" onclick="deleteUser('${u.id}')" title="Löschen">
                <svg viewBox="0 0 24 24" stroke-width="2" style="width:16px;height:16px;" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                    <path d="M10 11v6M14 11v6"/>
                    <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                </svg>
            </button>` : "";

        return `
            <div class="u-card" id="uc-${u.id}">
                <div class="u-av ${u.role === "collaborator" ? "u-av--f" : "u-av--k"}">${esc(initials)}</div>
                <div class="u-info">
                    <div class="u-name">${esc(name)}</div>
                    <div class="u-email">${esc(u.email)}</div>
                </div>
                ${u.fn ? `<span class="badge badge--fn">${esc(u.fn)}</span>` : ""}
                <span class="${roleClass}">${roleLabel}</span>
                <div class="u-actions">${adminActions}</div>
            </div>`;
    }).join("");
}

// --- AKTIONEN ---

function showConfirm(text, onOk) {
    const modal = byId("confirmModal");
    byId("confirmText").textContent = text;
    modal.classList.add("open");

    const okBtn = byId("confirmOkBtn");
    const cancelBtn = byId("confirmCancelBtn");

    function cleanup() {
        modal.classList.remove("open");
        okBtn.removeEventListener("click", handleOk);
        cancelBtn.removeEventListener("click", handleCancel);
    }
    function handleOk() { cleanup(); onOk(); }
    function handleCancel() { cleanup(); }

    okBtn.addEventListener("click", handleOk);
    cancelBtn.addEventListener("click", handleCancel);
}

async function sendInvite(targetUserId) {
    showConfirm("Einladungs-E-Mail jetzt an diesen Benutzer senden?", async () => {
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
    });
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

    const payload = {
        first_name: byId("edit-vorname").value.trim(),
        last_name: byId("edit-nachname").value.trim(),
        email: byId("edit-email").value.trim(),
        mobile: byId("edit-mobile").value.trim(),
        function_label: byId("edit-funktion").value.trim(),
        case_id: byId("edit-case").value || null,
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
    showConfirm("Benutzer wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.", async () => {
        byId("confirmOkBtn").textContent = "Löscht …";
        byId("confirmOkBtn").disabled = true;
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
            byId("confirmOkBtn").textContent = "Senden";
            byId("confirmOkBtn").disabled = false;
        }
    });
}

// --- MODAL & FILTER ---

function openEditModal(id) {
    const u = allUsers.find(user => String(user.id) === String(id));
    if (!u) return;

    modalMode = "edit";
    currentEditId = id;
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

async function loadCasesForModal() {
    const sel = byId("edit-case");
    if (!sel) return;
    try {
        const res = await fetch(`${API}/cases`, { headers: authHdr(), credentials: "include" });
        const data = await res.json();
        const cases = data.cases || data || [];
        sel.innerHTML = `<option value="">Keinem Fall zugewiesen</option>` + 
            cases.map(c => `<option value="${c.id}">${esc(c.case_name || c.title)}</option>`).join("");
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
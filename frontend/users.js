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

        return `
            <div class="u-card" id="uc-${u.id}">
                <div class="u-av ${u.role === "collaborator" ? "u-av--f" : "u-av--k"}">${esc(initials)}</div>
                <div class="u-info">
                    <div class="u-name">${esc(name)}</div>
                    <div class="u-email">${esc(u.email)}</div>
                </div>
                ${u.fn ? `<span class="badge badge--fn">${esc(u.fn)}</span>` : ""}
                <span class="${roleClass}">${roleLabel}</span>
                
                <div class="u-actions">
                    <button class="ib ib--invite" onclick="sendInvite('${u.id}')" title="Einladung senden">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px; height:18px;">
                            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                            <polyline points="22,6 12,13 2,6"></polyline>
                        </svg>
                    </button>
                    <button class="ib ib--edit" onclick="openEditModal('${u.id}')" title="Bearbeiten">
                        <svg viewBox="0 0 24 24" stroke-width="2" style="width:18px; height:18px;"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg>
                    </button>
                    <button class="ib ib--del" onclick="deleteUser('${u.id}')" title="Löschen">
                        <svg viewBox="0 0 24 24" stroke-width="2" style="width:18px; height:18px;"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                    </button>
                </div>
            </div>
        `;
    }).join("");
}

// --- AKTIONEN ---

async function sendInvite(targetUserId) {
    if (!confirm("Einladungs-E-Mail jetzt an diesen Benutzer senden?")) return;
    document.body.style.cursor = 'wait';
    try {
        const res = await fetch(`${BASE_URL}/${myUserId}/users/${targetUserId}/send-invite`, {
            method: "POST", headers: authHdr(), credentials: "include"
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Versand fehlgeschlagen");
        alert("✓ Einladung erfolgreich versendet!");
    } catch (err) {
        alert("Fehler: " + err.message);
    } finally {
        document.body.style.cursor = 'default';
    }
}

async function handleSave() {
    const payload = {
        first_name: byId("edit-vorname").value.trim(),
        last_name: byId("edit-nachname").value.trim(),
        email: byId("edit-email").value.trim(),
        mobile: byId("edit-mobile").value.trim(),
        function_label: byId("edit-funktion").value.trim(),
        case_id: byId("edit-case").value || null
    };

    const btn = byId("modalSaveBtn");
    if (btn) btn.disabled = true;

    try {
        const method = modalMode === "edit" ? "PATCH" : "POST";
        const url = modalMode === "edit" ? `${BASE_URL}/${currentEditId}` : `${BASE_URL}/${myUserId}/users`;

        const res = await fetch(url, {
            method, headers: authHdr(), credentials: "include", body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || "Speichern fehlgeschlagen");
        }

        await loadUsers();
        closeModal();
    } catch (err) {
        alert(err.message);
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function deleteUser(id) {
    if (!confirm("Benutzer wirklich löschen?")) return;
    try {
        const res = await fetch(`${BASE_URL}/${id}`, { 
            method: "DELETE", headers: authHdr(), credentials: "include" 
        });
        if (!res.ok) throw new Error("Löschen fehlgeschlagen");
        await loadUsers();
    } catch (err) {
        alert(err.message);
    }
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

    byId("modalTitle").textContent = "Benutzer bearbeiten";
    byId("modalSaveBtn").textContent = "Änderungen speichern";
    byId("userModal").classList.add("open");
}

function openAddModal() {
    modalMode = "add";
    byId("userModalForm").reset();
    byId("modalTitle").textContent = "Neuen Benutzer anlegen";
    byId("modalSaveBtn").textContent = "Anlegen";
    byId("userModal").classList.add("open");
}

function closeModal() { byId("userModal").classList.remove("open"); }

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

// Global verfügbar machen für HTML-Attribut-Events
window.sendInvite = sendInvite;
window.openEditModal = openEditModal;
window.openAddModal = openAddModal;
window.closeModal = closeModal;
window.deleteUser = deleteUser;
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
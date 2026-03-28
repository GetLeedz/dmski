/* users.js – Benutzerverwaltung */
"use strict";

const BASE_URL = "https://lively-reverence-production-def3.up.railway.app/api/users";
const API = "https://lively-reverence-production-def3.up.railway.app/api";

const getToken = () => sessionStorage.getItem("token") || localStorage.getItem("token") || "";
const authHdr = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` });

let allUsers = [];
let isAdmin = false;
let myUserId = 0;
let modalMode = "add";
let currentEditId = null;

function byId(id) { return document.getElementById(id); }

document.addEventListener("DOMContentLoaded", async () => {
    const yearEl = byId("copyrightYear");
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    if (!getToken()) {
        window.location.replace("/");
        return;
    }

    // Event Listeners
    byId("logoutBtn")?.addEventListener("click", () => {
        sessionStorage.clear();
        localStorage.removeItem("token");
        window.location.href = "/";
    });

    byId("userModal")?.addEventListener("click", (e) => {
        if (e.target === byId("userModal")) closeModal();
    });

    byId("userModalForm")?.addEventListener("submit", (e) => {
        e.preventDefault();
        void handleSave();
    });

    // Auth Check & Role Loading
    try {
        const res = await fetch(`${BASE_URL}/me`, { headers: authHdr(), credentials: "include" });
        if (!res.ok) throw new Error("Unauthorized");
        
        const data = await res.json();
        const user = data?.user || {};
        isAdmin = user.role === "admin";
        myUserId = user.id; // UUID oder ID
        
        sessionStorage.setItem("dmski_role", user.role || "customer");
        sessionStorage.setItem("dmski_user_id", String(myUserId));
    } catch (err) {
        window.location.replace("/");
        return;
    }

    byId("authGate").style.display = "none";
    byId("usersMain").style.display = "";
    if (isAdmin && byId("roleFilter")) byId("roleFilter").style.display = "";

    await loadUsers();
    await loadCasesForModal();
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
            method: "POST",
            headers: authHdr(),
            credentials: "include"
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
    btn.disabled = true;

    try {
        const method = modalMode === "edit" ? "PATCH" : "POST";
        const url = modalMode === "edit" ? `${BASE_URL}/${currentEditId}` : `${BASE_URL}/${myUserId}/users`;

        const res = await fetch(url, {
            method,
            headers: authHdr(),
            credentials: "include",
            body: JSON.stringify(payload)
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
        btn.disabled = false;
    }
}

async function deleteUser(id) {
    if (!confirm("Benutzer wirklich löschen?")) return;
    try {
        const res = await fetch(`${BASE_URL}/${id}`, { 
            method: "DELETE", 
            headers: authHdr(), 
            credentials: "include" 
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
    byId("userModal").classList.add("open");
}

function openAddModal() {
    modalMode = "add";
    byId("userModalForm").reset();
    byId("modalTitle").textContent = "Neuen Benutzer anlegen";
    byId("userModal").classList.add("open");
}

function closeModal() { byId("userModal").classList.remove("open"); }

function esc(v) {
    return String(v ?? "").replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">").replace(/"/g, """);
}

async function loadCasesForModal() {
    const sel = byId("edit-case");
    if (!sel) return;
    try {
        const res = await fetch(`${API}/cases`, { headers: authHdr(), credentials: "include" });
        const data = await res.json();
        const cases = data.cases || [];
        sel.innerHTML = `<option value="">Keinem Fall zugewiesen</option>` + 
            cases.map(c => `<option value="${c.id}">${esc(c.case_name)}</option>`).join("");
    } catch (e) { console.error("Cases load error", e); }
}

// Exports für HTML
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
        const matchesFn = fnFilter ? (u.fn.toLowerCase() === fnFilter) : true;
        const matchesRole = roleFilter ? (u.role.toLowerCase() === roleFilter) : true;
        return matchesSearch && matchesFn && matchesRole;
    }));
};

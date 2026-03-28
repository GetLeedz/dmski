/* script.js – Login & Authentifizierung */
"use strict";

const loginForm = document.getElementById("loginForm");
const messageEl = document.getElementById("message");
const submitButton = document.getElementById("submitButton");
const passwordInput = document.getElementById("password");
const togglePasswordButton = document.getElementById("togglePassword");
const emailInput = document.getElementById("email");
const rememberInput = document.getElementById("remember");
const copyrightYearEl = document.getElementById("copyrightYear");

const API_BASE = "https://lively-reverence-production-def3.up.railway.app/api";

// Hilfsfunktionen für Nachrichten
function setMessage(text, type) {
    if (!messageEl) return;
    messageEl.textContent = text;
    messageEl.className = "message " + (type || "");
    messageEl.style.display = text ? "block" : "none";
}

// Passwort-Sichtbarkeit umschalten
if (togglePasswordButton) {
    togglePasswordButton.addEventListener("click", () => {
        const isPassword = passwordInput.type === "password";
        passwordInput.type = isPassword ? "text" : "password";
        togglePasswordButton.classList.toggle("is-visible", isPassword);
    });
}

// Copyright Jahr setzen
if (copyrightYearEl) {
    copyrightYearEl.textContent = String(new Date().getFullYear());
}

// E-Mail "Merken" Logik
const REMEMBER_KEY = "dmski_remember_email";
if (emailInput && rememberInput) {
    const savedEmail = localStorage.getItem(REMEMBER_KEY);
    if (savedEmail) {
        emailInput.value = savedEmail;
        rememberInput.checked = true;
    }
}

// --- LOGIN SUBMIT ---

loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const email = emailInput.value.trim();
    const password = passwordInput.value;

    if (!email || !password) {
        setMessage("Bitte E-Mail und Passwort eingeben.", "error");
        return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Anmelden...";
    setMessage("", "");

    try {
        const res = await fetch(`${API_BASE}/auth/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password }),
        });

        const data = await res.json();

        if (!res.ok) {
            setMessage(data.error || "Anmeldung fehlgeschlagen.", "error");
            submitButton.disabled = false;
            submitButton.textContent = "Anmelden";
            return;
        }

        // --- SESSION SPEICHERN ---
        // Wir speichern das Token in sessionStorage (Sitzung) 
        // und optional in localStorage (wenn "Angemeldet bleiben" aktiv)
        sessionStorage.setItem("token", data.token);
        sessionStorage.setItem("dmski_user_id", String(data.id || ""));
        sessionStorage.setItem("dmski_role", data.role || "customer");
        sessionStorage.setItem("dmski_pwd_change", data.password_change_required ? "1" : "0");

        if (rememberInput.checked) {
            localStorage.setItem(REMEMBER_KEY, email);
            localStorage.setItem("token", data.token);
        } else {
            localStorage.removeItem(REMEMBER_KEY);
        }

        setMessage("Erfolgreich angemeldet. Weiterleitung...", "success");

        setTimeout(() => {
            // Passwort-Änderung erzwingen
            if (data.password_change_required) {
                window.location.href = "/profile.html?mustchange=1";
                return;
            }
            if (data.role === "admin") {
                window.location.href = "/users.html";
            } else {
                window.location.href = "/dashboard.html";
            }
        }, 800);

    } catch (err) {
        console.error("Login-Fehler:", err);
        setMessage("Server nicht erreichbar. Bitte später erneut versuchen.", "error");
        submitButton.disabled = false;
        submitButton.textContent = "Anmelden";
    }
});
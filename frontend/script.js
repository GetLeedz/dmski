const loginForm = document.getElementById("loginForm");
const messageEl = document.getElementById("message");
const submitButton = document.getElementById("submitButton");
const passwordInput = document.getElementById("password");
const togglePasswordButton = document.getElementById("togglePassword");
const emailInput = document.getElementById("email");
const rememberInput = document.getElementById("remember");
const copyrightYearEl = document.getElementById("copyrightYear");

// Password policy: min 10 chars, 1 uppercase, 1 number, 1 special char
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{10,}$/;

const host = String(window.location.hostname || "").toLowerCase();
const isLocalHost = host === "localhost"
  || host === "127.0.0.1"
  || host === "0.0.0.0"
  || host === "::1"
  || host.endsWith(".local")
  || /^192\.168\./.test(host)
  || /^10\./.test(host)
  || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);

const API_BASE = isLocalHost
  ? "http://localhost:4000"
  : "https://lively-reverence-production-def3.up.railway.app";

const REMEMBER_EMAIL_KEY = "dmski.remember.email";
const LOGIN_MESSAGE_KEY = "loginMessage";

function restoreRememberedEmail() {
  const rememberedEmail = localStorage.getItem(REMEMBER_EMAIL_KEY);
  if (!rememberedEmail) return;
  emailInput.value = rememberedEmail;
  rememberInput.checked = true;
}

function persistRememberedEmail(email) {
  if (rememberInput.checked) {
    localStorage.setItem(REMEMBER_EMAIL_KEY, email);
    return;
  }
  localStorage.removeItem(REMEMBER_EMAIL_KEY);
}

function togglePasswordVisibility() {
  const isPassword = passwordInput.type === "password";
  passwordInput.type = isPassword ? "text" : "password";
  togglePasswordButton.classList.toggle("is-visible", isPassword);
  togglePasswordButton.setAttribute("aria-pressed", String(isPassword));
  togglePasswordButton.setAttribute("aria-label", isPassword ? "Passwort verbergen" : "Passwort anzeigen");
}

async function storeBrowserCredential(email, password) {
  if (typeof window.PasswordCredential === "undefined" || !navigator.credentials?.store) {
    return;
  }

  try {
    const credential = new window.PasswordCredential({ id: email, password, name: email });
    await navigator.credentials.store(credential);
  } catch {
    // Browser or policy can block credential storage silently.
  }
}

function setMessage(text, type) {
  messageEl.textContent = text;
  messageEl.classList.remove("success", "error");
  if (type) messageEl.classList.add(type);
}

function consumeLoginMessage() {
  const message = sessionStorage.getItem(LOGIN_MESSAGE_KEY);
  if (!message) {
    return;
  }

  sessionStorage.removeItem(LOGIN_MESSAGE_KEY);
  setMessage(message, "error");
}

restoreRememberedEmail();
consumeLoginMessage();
togglePasswordButton.addEventListener("click", togglePasswordVisibility);
if (copyrightYearEl) {
  copyrightYearEl.textContent = String(new Date().getFullYear());
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(loginForm);
  const email = String(formData.get("email") || "").trim();
  const password = String(formData.get("password") || "");

  if (!email || !password) {
    setMessage("Bitte E-Mail und Passwort eingeben.", "error");
    return;
  }

  if (!PASSWORD_REGEX.test(password)) {
    setMessage(
      "Passwort muss mindestens 10 Zeichen, einen Grossbuchstaben, eine Zahl und ein Sonderzeichen enthalten.",
      "error"
    );
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Anmelden...";
  setMessage("", null);

  try {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();

    if (!res.ok) {
      setMessage(data.error || "Anmeldung fehlgeschlagen.", "error");
      return;
    }

    // Store JWT token securely
    sessionStorage.setItem("token", data.token);
    persistRememberedEmail(email);
    await storeBrowserCredential(email, password);
    setMessage("Erfolgreich angemeldet. Weiterleitung...", "success");

    setTimeout(() => {
      window.location.href = "/dashboard.html";
    }, 1000);
  } catch {
    setMessage("Server nicht erreichbar. Bitte später erneut versuchen.", "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Anmelden";
  }
});

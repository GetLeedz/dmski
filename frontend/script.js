const loginForm = document.getElementById("loginForm");
const messageEl = document.getElementById("message");
const submitButton = document.getElementById("submitButton");

// Password policy: min 10 chars, 1 uppercase, 1 number, 1 special char
const PASSWORD_REGEX = /^(?=.*[A-Z])(?=.*[0-9])(?=.*[^A-Za-z0-9]).{10,}$/;

const API_BASE = window.location.hostname === "localhost"
  ? "http://localhost:4000"
  : "https://api.dmski.aikmu.ch";

function setMessage(text, type) {
  messageEl.textContent = text;
  messageEl.classList.remove("success", "error");
  if (type) messageEl.classList.add(type);
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

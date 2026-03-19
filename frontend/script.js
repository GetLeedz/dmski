const loginForm = document.getElementById("loginForm");
const messageEl = document.getElementById("message");
const submitButton = document.getElementById("submitButton");

function setMessage(text, type) {
  messageEl.textContent = text;
  messageEl.classList.remove("success", "error");
  if (type) {
    messageEl.classList.add(type);
  }
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

  if (password.length < 8) {
    setMessage("Das Passwort muss mindestens 8 Zeichen haben.", "error");
    return;
  }

  submitButton.disabled = true;
  submitButton.textContent = "Pruefe...";
  setMessage("", null);

  try {
    // Placeholder for backend request integration.
    await new Promise((resolve) => setTimeout(resolve, 700));
    setMessage("Login-Daten sind gueltig. Backend-API kann jetzt verbunden werden.", "success");
  } catch (error) {
    setMessage("Anmeldung fehlgeschlagen. Bitte erneut versuchen.", "error");
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "Anmelden";
  }
});

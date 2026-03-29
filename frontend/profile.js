/* profile.js – My Profile */
const _h = String(window.location.hostname || "").toLowerCase();
const API = "https://lively-reverence-production-def3.up.railway.app/api";
const getToken = () => sessionStorage.getItem("token") || "";
const getRole = () => sessionStorage.getItem("dmski_role") || "customer";
const authHdr = () => ({ "Content-Type": "application/json", Authorization: `Bearer ${getToken()}` });

const mustChange = new URLSearchParams(window.location.search).get("mustchange") === "1"
  || sessionStorage.getItem("dmski_pwd_change") === "1";

document.addEventListener("DOMContentLoaded", async () => {
  const yearEl = document.getElementById("copyrightYear");
  if (yearEl) yearEl.textContent = new Date().getFullYear();
  const token = getToken();
  if (!token) { sessionStorage.removeItem("token"); window.location.replace("/"); return; }

  document.getElementById("authGate").style.display = "none";
  document.getElementById("profileMain").style.display = "";

  try { await loadProfile(); } catch (err) {
    if (err.status === 401 || err.status === 403) { sessionStorage.removeItem("token"); window.location.replace("/"); return; }
    showMsg(document.getElementById("profileMsg"), "Profil konnte nicht geladen werden.", "error");
  }

  document.getElementById("profileForm").addEventListener("submit", onSave);

  // Password change enforced
  if (mustChange) {
    const banner = document.getElementById("pwdChangeBanner");
    if (banner) banner.style.display = "";
    const pwBox = document.querySelector(".password-box");
    if (pwBox) {
      pwBox.style.border = "2px solid #C5A059";
      pwBox.scrollIntoView({ behavior: "smooth" });
    }
    // Change label from optional to required
    const pwTitle = document.querySelector(".password-box-title span");
    if (pwTitle) pwTitle.textContent = "(Pflichtfeld — bitte ändern Sie Ihr temporäres Passwort)";
  }

  // PW generator button
  const genBtn = document.getElementById("pwdGenBtn");
  if (genBtn) {
    genBtn.addEventListener("click", () => {
      const pw = generatePassword();
      document.getElementById("fieldNewPwd").value = pw;
      document.getElementById("fieldNewPwd2").value = pw;
      document.getElementById("fieldNewPwd").type = "text";
      document.getElementById("fieldNewPwd2").type = "text";
      validatePassword(pw);
    });
  }

  // PW eye toggle
  const eyeBtn = document.getElementById("pwdEyeBtn");
  if (eyeBtn) {
    eyeBtn.addEventListener("click", () => {
      const f1 = document.getElementById("fieldNewPwd");
      const f2 = document.getElementById("fieldNewPwd2");
      const show = f1.type === "password";
      f1.type = show ? "text" : "password";
      f2.type = show ? "text" : "password";
      eyeBtn.classList.toggle("is-visible", show);
    });
  }

  // Live validation
  const pwInput = document.getElementById("fieldNewPwd");
  if (pwInput) {
    pwInput.addEventListener("input", () => validatePassword(pwInput.value));
  }
});

async function loadProfile() {
  const res = await fetch(`${API}/users/me`, { headers: authHdr() });
  if (res.status === 401 || res.status === 403) { const e = new Error(); e.status = res.status; throw e; }
  if (!res.ok) { const d = await res.json().catch(() => ({})); const e = new Error(d.error || "Fehler"); e.status = res.status; throw e; }
  const { user } = await res.json();
  sessionStorage.setItem("dmski_role", user.role || "customer");
  sessionStorage.setItem("dmski_user_id", String(user.id));

  const letter = (user.first_name || user.email || "?")[0].toUpperCase();
  const fullName = [user.academic_title, user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;
  document.getElementById("avatarLetter").textContent = letter;
  document.getElementById("profileName").textContent = fullName;
  document.getElementById("profileEmail").textContent = user.email;

  const badge = document.getElementById("profileBadge");
  const labels = { admin: "Administrator", customer: "Kunde (Fallinhaber)", collaborator: "Team" };
  badge.textContent = labels[user.role] || user.role;
  badge.className = `badge-role badge-${user.role || "customer"}`;

  // Populate form
  const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val || ""; };
  setVal("fieldSalutation", user.salutation);
  setVal("fieldTitle", user.academic_title);
  setVal("fieldFirstName", user.first_name);
  setVal("fieldLastName", user.last_name);
  setVal("fieldEmail", user.email);
  setVal("fieldAddress", user.address);
  setVal("fieldMobile", user.mobile);

  if (user.role === "collaborator") {
    const g = document.getElementById("fieldFunctionGroup");
    const s = document.getElementById("fieldFunction");
    if (g) g.style.display = "";
    if (s && user.function_label) s.value = user.function_label;
  }
}

async function onSave(e) {
  e.preventDefault();
  const btn = e.target.querySelector("button[type=submit]");
  const msg = document.getElementById("profileMsg");
  showMsg(msg, "");

  const np = document.getElementById("fieldNewPwd").value.trim();
  const np2 = document.getElementById("fieldNewPwd2").value.trim();
  const cp = document.getElementById("fieldCurrentPwd").value;

  // Enforce password change on first login
  if (mustChange && !np) {
    showMsg(msg, "Sie müssen ein neues Passwort setzen, bevor Sie fortfahren können.", "error");
    document.getElementById("fieldNewPwd").focus();
    return;
  }

  if (np && np !== np2) { showMsg(msg, "Die neuen Passwörter stimmen nicht überein.", "error"); return; }

  if (np && !isPasswordValid(np)) {
    showMsg(msg, "Passwort erfüllt nicht alle Anforderungen (mind. 10 Zeichen, Gross-/Kleinbuchstaben, Zahl, Sonderzeichen).", "error");
    return;
  }

  const body = {
    salutation: document.getElementById("fieldSalutation")?.value || "",
    academic_title: document.getElementById("fieldTitle")?.value || "",
    email: document.getElementById("fieldEmail").value.trim(),
    first_name: document.getElementById("fieldFirstName").value.trim(),
    last_name: document.getElementById("fieldLastName").value.trim(),
    address: document.getElementById("fieldAddress").value.trim(),
    mobile: document.getElementById("fieldMobile").value.trim(),
  };
  if (np) { body.password = np; body.currentPassword = cp; }
  const fg = document.getElementById("fieldFunctionGroup");
  if (fg && fg.style.display !== "none") body.function_label = document.getElementById("fieldFunction").value || "";

  if (btn) { btn.disabled = true; btn.textContent = "Speichert …"; }
  try {
    const res = await fetch(`${API}/users/me`, { method: "PATCH", headers: authHdr(), body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) { showMsg(msg, data.error || "Fehler.", "error"); return; }
    showMsg(msg, "Profil erfolgreich gespeichert.", "success");
    ["fieldCurrentPwd", "fieldNewPwd", "fieldNewPwd2"].forEach(id => (document.getElementById(id).value = ""));
    if (mustChange) {
      sessionStorage.removeItem("dmski_pwd_change");
      setTimeout(() => { window.location.href = "/dashboard.html"; }, 1500);
    }
    await loadProfile();
  } catch { showMsg(msg, "Netzwerkfehler.", "error"); }
  finally { if (btn) { btn.disabled = false; btn.textContent = "Speichern"; } }
}

function showMsg(el, text, type = "") {
  el.textContent = text;
  el.className = `message${type ? ` message--${type}` : ""}`;
}

// Password generator
function generatePassword() {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%&*+?";
  const all = upper + lower + digits + special;
  const pick = (s) => s[Math.floor(Math.random() * s.length)];
  const result = [pick(upper), pick(lower), pick(digits), pick(special)];
  for (let i = 4; i < 14; i++) result.push(pick(all));
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result.join("");
}

// Password validation
function isPasswordValid(pw) {
  return pw.length >= 10 && /[A-Z]/.test(pw) && /[a-z]/.test(pw) && /[0-9]/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}

function validatePassword(pw) {
  const checks = [
    { id: "pw-len", ok: pw.length >= 10 },
    { id: "pw-upper", ok: /[A-Z]/.test(pw) },
    { id: "pw-lower", ok: /[a-z]/.test(pw) },
    { id: "pw-num", ok: /[0-9]/.test(pw) },
    { id: "pw-special", ok: /[^A-Za-z0-9]/.test(pw) },
  ];
  checks.forEach(c => {
    const el = document.getElementById(c.id);
    if (el) {
      el.classList.toggle("pw-ok", c.ok);
      el.classList.toggle("pw-fail", !c.ok);
    }
  });
}

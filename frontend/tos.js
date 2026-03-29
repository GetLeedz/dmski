/* tos.js – Nutzungsbedingungen Popup */
(function () {
  const API = "https://lively-reverence-production-def3.up.railway.app/api";
  const getToken = () => sessionStorage.getItem("token") || localStorage.getItem("token") || "";

  async function checkTos() {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(`${API}/users/me`, {
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      });
      if (!res.ok) return;
      const { user } = await res.json();
      if (!user.tos_accepted_at) {
        showTosModal();
      }
    } catch {
      // Netzwerkfehler – ToS-Prüfung überspringen
    }
  }

  function showTosModal() {
    const modal = document.getElementById("tosModal");
    if (!modal) return;
    modal.style.display = "flex";

    document.getElementById("tosAcceptBtn").addEventListener("click", async () => {
      const token = getToken();
      try {
        await fetch(`${API}/users/me/accept-tos`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        });
      } catch { /* ignorieren */ }
      modal.style.display = "none";
    });

    document.getElementById("tosDenyBtn").addEventListener("click", () => {
      sessionStorage.clear();
      localStorage.removeItem("token");
      window.location.replace("/");
    });
  }

  // Startet nach kurzem Delay, damit dashboard.js zuerst Auth prüfen kann
  setTimeout(checkTos, 600);
})();

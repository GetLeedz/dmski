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

    const scrollBox = document.getElementById("tosScrollBox");
    const acceptBtn = document.getElementById("tosAcceptBtn");
    const scrollHint = document.getElementById("tosScrollHint");

    function checkScroll() {
      if (!scrollBox || !acceptBtn) return;
      const atBottom = scrollBox.scrollTop + scrollBox.clientHeight >= scrollBox.scrollHeight - 10;
      if (atBottom) {
        acceptBtn.disabled = false;
        acceptBtn.style.background = "linear-gradient(135deg,#1A2B3C,#0F1E2B)";
        acceptBtn.style.cursor = "pointer";
        if (scrollHint) scrollHint.style.display = "none";
      }
    }
    if (scrollBox) {
      scrollBox.addEventListener("scroll", checkScroll);
      // Check immediately in case content is short enough
      setTimeout(checkScroll, 100);
    }

    acceptBtn.addEventListener("click", async () => {
      if (acceptBtn.disabled) return;
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

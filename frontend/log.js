/* log.js – Admin Aktivitätslog */
(function () {
  const token = sessionStorage.getItem("token");
  const role = sessionStorage.getItem("dmski_role") || "";
  if (!token) { window.location.replace("/login.html"); return; }
  if (role !== "admin") { window.location.replace("/dashboard.html"); return; }

  const main = document.getElementById("logMain");
  const gate = document.getElementById("authGate");
  if (main) main.style.display = "";
  if (gate) gate.remove();

  const host = String(window.location.hostname || "").toLowerCase();
  const isLocal = host === "localhost" || host === "127.0.0.1";
  const API = isLocal ? "/api" : "https://lively-reverence-production-def3.up.railway.app/api";

  const PER_PAGE = 50;
  let currentOffset = 0;
  let totalLogs = 0;

  const logLoading = document.getElementById("logLoading");
  const logTable = document.getElementById("logTable");
  const logBody = document.getElementById("logBody");
  const logEmpty = document.getElementById("logEmpty");
  const logPagination = document.getElementById("logPagination");
  const pageInfo = document.getElementById("pageInfo");
  const prevBtn = document.getElementById("prevBtn");
  const nextBtn = document.getElementById("nextBtn");
  const refreshBtn = document.getElementById("refreshBtn");
  const filterAction = document.getElementById("filterAction");

  function actionLabel(action) {
    if (action.startsWith("page:")) {
      const page = action.replace("page:", "").replace(/^\//, "").replace(".html", "") || "home";
      const pageNames = { dashboard: "Dashboard", files: "Files", upload: "Upload", users: "Benutzer", profile: "Profil", log: "Log" };
      return `<span class="log-action pageview">${pageNames[page] || page}</span>`;
    }
    const map = {
      login: "Login",
      logout: "Logout",
      login_failed: "Fehlgeschlagen"
    };
    return `<span class="log-action ${action}">${map[action] || action}</span>`;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    const pad = n => String(n).padStart(2, "0");
    return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function shortBrowser(ua) {
    if (!ua) return "–";
    if (ua.includes("Chrome") && !ua.includes("Edg")) return "Chrome";
    if (ua.includes("Edg")) return "Edge";
    if (ua.includes("Firefox")) return "Firefox";
    if (ua.includes("Safari") && !ua.includes("Chrome")) return "Safari";
    return ua.substring(0, 30) + "…";
  }

  async function loadLogs() {
    logLoading.style.display = "";
    logTable.style.display = "none";
    logEmpty.style.display = "none";

    try {
      const actionVal = filterAction ? filterAction.value : "";
      const actionParam = actionVal ? `&action=${encodeURIComponent(actionVal)}` : "";
      const res = await fetch(`${API}/audit/logs?limit=${PER_PAGE}&offset=${currentOffset}${actionParam}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (res.status === 401) { sessionStorage.clear(); window.location.replace("/login.html"); return; }
      if (res.status === 403) { window.location.replace("/dashboard.html"); return; }
      if (!res.ok) throw new Error("Fehler " + res.status);

      const data = await res.json();
      totalLogs = data.total || 0;

      logLoading.style.display = "none";

      if (!data.logs || data.logs.length === 0) {
        logEmpty.style.display = "";
        logPagination.style.display = "none";
        return;
      }

      logBody.innerHTML = data.logs.map(l => {
        const name = [l.first_name, l.last_name].filter(Boolean).join(" ") || "–";
        return `<tr>
          <td style="white-space:nowrap">${formatDate(l.created_at)}</td>
          <td><strong style="color:#fff">${name}</strong><br><span style="font-size:.82rem;color:rgba(255,255,255,.5)">${l.email}</span></td>
          <td>${actionLabel(l.action)}</td>
          <td style="font-family:monospace;font-size:.82rem;color:rgba(255,255,255,.5)">${l.ip || "–"}</td>
          <td class="log-browser" title="${(l.user_agent || "").replace(/"/g, "&quot;")}">${shortBrowser(l.user_agent)}</td>
        </tr>`;
      }).join("");

      logTable.style.display = "";

      // Pagination
      const totalPages = Math.ceil(totalLogs / PER_PAGE);
      const currentPage = Math.floor(currentOffset / PER_PAGE) + 1;

      if (totalPages > 1) {
        logPagination.style.display = "flex";
        pageInfo.textContent = `Seite ${currentPage} von ${totalPages} (${totalLogs} Einträge)`;
        prevBtn.disabled = currentOffset === 0;
        nextBtn.disabled = currentOffset + PER_PAGE >= totalLogs;
      } else {
        logPagination.style.display = "none";
      }
    } catch (err) {
      logLoading.innerHTML = `<span style="color:#ff6b6b">Fehler beim Laden: ${err.message}</span>`;
    }
  }

  if (prevBtn) prevBtn.addEventListener("click", () => { currentOffset = Math.max(0, currentOffset - PER_PAGE); loadLogs(); });
  if (nextBtn) nextBtn.addEventListener("click", () => { currentOffset += PER_PAGE; loadLogs(); });
  if (refreshBtn) refreshBtn.addEventListener("click", () => { currentOffset = 0; loadLogs(); });
  if (filterAction) filterAction.addEventListener("change", () => { currentOffset = 0; loadLogs(); });

  loadLogs();

  // Auto-refresh every 15 seconds (only on first page)
  setInterval(() => {
    if (currentOffset === 0) loadLogs();
  }, 15000);
})();

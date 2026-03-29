/* nav.js – Einheitliche Top-Navigation für alle App-Seiten */
(function () {
  const role = sessionStorage.getItem("dmski_role") || localStorage.getItem("dmski_role") || "customer";
  const path = window.location.pathname.replace(/\/$/, "") || "/";

  function isActive(href) {
    const target = href.replace(/\/$/, "") || "/";
    return path === target || path.endsWith(target);
  }

  function navLink(href, label, svgPath) {
    const active = isActive(href) ? ' aria-current="page" style="opacity:1;font-weight:600;"' : '';
    return `
      <a href="${href}" class="ghost topbar-link" style="text-decoration:none;font-size:.875rem;display:inline-flex;align-items:center;gap:.28rem"${active}>
        <svg viewBox="0 0 20 20" fill="none" style="width:1em;height:1em;flex-shrink:0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          ${svgPath}
        </svg>
        ${label}
      </a>`;
  }

  const links = {
    dashboard: navLink(
      "/dashboard.html", "Dashboard",
      '<path d="M3 10.5L10 4l7 6.5"/><path d="M5 9v7h4v-4h2v4h4V9"/>'
    ),
    users: navLink(
      "/users.html", "Benutzer",
      '<path d="M13 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/><path d="M2 17c0-3.314 3.582-5 8-5s8 1.686 8 5"/><path d="M16 7v4M18 9h-4"/>'
    ),
    profile: navLink(
      "/profile.html", "Profil",
      '<circle cx="10" cy="7" r="3.5"/><path d="M3 17c0-3.314 3.134-6 7-6s7 2.686 7 6"/>'
    ),
  };

  const adminNav = role === "admin" ? links.users : "";

  const html = `
    <header class="topbar" id="dmski-topbar">
      <div class="brand-lockup">
        <a href="/dashboard.html" class="brand-home-link" aria-label="Dashboard">
          <img src="/assets/logo-dmski.png" alt="DMSKI" class="header-logo" />
        </a>
      </div>
      <nav style="display:flex;gap:.35rem;align-items:center">
        ${links.dashboard}
        ${adminNav}
        ${links.profile}
        <button id="logoutBtn" class="ghost" type="button">Logout</button>
      </nav>
    </header>`;

  const container = document.getElementById("site-nav");
  if (container) {
    container.outerHTML = html;
  }

  // Default logout handler — JS-Dateien können eigene Handler hinzufügen
  document.addEventListener("DOMContentLoaded", function () {
    const btn = document.getElementById("logoutBtn");
    if (btn && !btn._navHandlerAttached) {
      btn._navHandlerAttached = true;
      btn.addEventListener("click", function () {
        sessionStorage.clear();
        localStorage.removeItem("token");
        window.location.href = "/";
      });
    }
  });
})();

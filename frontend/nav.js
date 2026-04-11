/* nav.js – Sidebar Navigation – DMSKI Design System */
(function () {
  const role = sessionStorage.getItem("dmski_role") || localStorage.getItem("dmski_role") || "customer";
  const path = window.location.pathname;

  // ── Enforce password change: redirect to profile if not already there ──
  const mustChangePwd = sessionStorage.getItem("dmski_pwd_change") === "1";
  const isProfilePage = path.endsWith("profile.html");
  if (mustChangePwd && !isProfilePage) {
    window.location.replace("/profile.html?mustchange=1");
    return;
  }

  function isActive(href) {
    return path === href || path.endsWith(href.replace(/^\//, ""));
  }

  function sbLink(href, label, svgInner, isBtn) {
    const active = !isBtn && isActive(href) ? " sb-active" : "";
    if (isBtn) {
      return `<button id="logoutBtn" type="button" class="sb-link sb-logout">${svgInner}<span>${label}</span></button>`;
    }
    return `<a href="${href}" class="sb-link${active}">${svgInner}<span>${label}</span></a>`;
  }

  const firstName = sessionStorage.getItem("dmski_first_name") || localStorage.getItem("dmski_first_name") || "";
  const creditBalance = parseInt(sessionStorage.getItem("dmski_credit_balance") || "0", 10);

  const icons = {
    dashboard: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L10 4l7 6.5"/><path d="M5 9v7h4v-4h2v4h4V9"/></svg>`,
    analysis:  `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 7h6M7 10h4"/></svg>`,
    upload:    `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4v9M6 7l4-4 4 4"/><path d="M3 14v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2"/></svg>`,
    users:     `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/><path d="M2 17c0-3.314 3.582-5 8-5s8 1.686 8 5"/><path d="M16 7v4M18 9h-4"/></svg>`,
    profile:   `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="7" r="3.5"/><path d="M3 17c0-3.314 3.134-6 7-6s7 2.686 7 6"/></svg>`,
    credits:   `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M10 6v8M7.5 8.5h3.75a1.25 1.25 0 0 1 0 2.5H7.5h3.75a1.25 1.25 0 0 1 0 2.5H7.5"/></svg>`,
    logout:    `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 10H3M7 6l-4 4 4 4"/><path d="M10 3h5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-5"/></svg>`,
  };

  const teamIcon = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/><path d="M2 17c0-3.314 3.582-5 8-5s8 1.686 8 5"/></svg>`;

  const icons_log = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h12a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"/><path d="M7 8h6M7 11h4"/></svg>`;

  let adminBlock = "";
  if (role === "admin") {
    adminBlock = `<span class="sb-section">Verwaltung</span>${sbLink("/users.html?view=all", "Alle Benutzer", icons.users)}${sbLink("/admin-credits.html", "Credits-Verwaltung", icons.credits)}${sbLink("/log.html", "Aktivitätslog", icons_log)}`;
  }
  // Team is now inside each case (files.html), not in sidebar

  const sidebarHTML = `
    <aside class="dmski-sidebar" id="dmski-sidebar" role="navigation" aria-label="Hauptnavigation">
      <div class="sb-logo-area">
        <a href="/dashboard.html" class="sb-brand">
          <img src="/assets/logo-dmski_gold.png" alt="DMSKI" class="sb-logo" />
        </a>
        <p class="sb-tagline">KI-Fallanalyse</p>
      </div>

      ${firstName ? `<div class="sb-greeting">Hallo ${firstName}</div>` : ""}
      <a href="/credits.html" class="sb-credit-badge" title="Credits: ${creditBalance}">
        ${icons.credits}<span>${creditBalance} Credits</span>
      </a>

      <nav class="sb-nav">
        <span class="sb-section">Plattform</span>
        ${sbLink("/dashboard.html", "Dashboard", icons.dashboard)}
        ${sbLink("/credits.html", "Credits", icons.credits)}
        ${adminBlock}
        ${sbLink("/profile.html", "Mein Profil", icons.profile)}
      </nav>

      <div class="sb-footer">
        ${sbLink(null, "Abmelden", icons.logout, true)}
      </div>
    </aside>`;

  // Inject sidebar into body
  const wrapper = document.createElement("div");
  wrapper.innerHTML = sidebarHTML;
  document.body.prepend(wrapper.firstElementChild);
  document.body.classList.add("has-sidebar");

  // Remove old site-nav placeholder
  const placeholder = document.getElementById("site-nav");
  if (placeholder) placeholder.remove();

  // ── Inject shared page-hero header ──
  const pageHeaders = {
    "/dashboard.html": {
      title: "Dashboard",
      sub: "Neuen Fall anlegen oder bestehenden Fall öffnen",
      icon: `<path d="M3 10.5L10 4l7 6.5"/><path d="M5 9v7h4v-4h2v4h4V9"/>`
    },
    "/files.html": {
      title: "Fall wird geladen…",
      sub: "",
      icon: `<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 7h6M7 10h4"/>`,
      dynamic: true
    },
    "/users.html": {
      title: role === "admin" ? "Alle Benutzer" : "Team",
      sub: role === "admin" ? "Übersicht aller Benutzer — Kunden & Fachpersonen" : "Ihr Team verwalten — Fachpersonen einladen und zuweisen",
      icon: `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>`
    },
    "/upload.html": {
      title: "File Upload",
      sub: "Files hochladen — automatische Analyse",
      icon: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>`
    },
    "/log.html": {
      title: "Aktivitätslog",
      sub: "Login, Logout und Session-Aktivitäten aller Benutzer",
      icon: `<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 8h8M8 12h5"/>`
    },
    "/credits.html": {
      title: "Credits",
      sub: "Ihr Credit-Guthaben und Pakete kaufen",
      icon: `<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.5h4.5a1.5 1.5 0 0 1 0 3H9h4.5a1.5 1.5 0 0 1 0 3H9"/>`
    },
    "/admin-credits.html": {
      title: "Credits-Verwaltung",
      sub: "Credit-Übersicht aller Benutzer und Einstellungen",
      icon: `<circle cx="12" cy="12" r="9"/><path d="M12 7v10M9 9.5h4.5a1.5 1.5 0 0 1 0 3H9h4.5a1.5 1.5 0 0 1 0 3H9"/>`
    }
  };

  const headerConfig = Object.entries(pageHeaders).find(([href]) => path.endsWith(href.replace(/^\//, "")));
  if (headerConfig) {
    const [, cfg] = headerConfig;
    const mainEl = document.querySelector(".page") || document.querySelector("main");
    if (mainEl) {
      // Remove old hero elements (u-hero, welcome-strip, profile-hero)
      const oldHeroes = mainEl.querySelectorAll(".u-hero, .welcome-strip, .profile-hero");
      oldHeroes.forEach(el => el.remove());

      const heroEl = document.createElement("div");
      heroEl.className = "page-hero";
      heroEl.innerHTML = `
        <div class="page-hero-icon">
          <svg viewBox="0 0 24 24">${cfg.icon}</svg>
        </div>
        <div class="page-hero-text">
          <h1>${cfg.title}</h1>
          <p>${cfg.sub}</p>
        </div>`;
      mainEl.insertBefore(heroEl, mainEl.firstChild);
    }
  }

  // Logout handler – log session end, then redirect
  document.addEventListener("DOMContentLoaded", function () {
    const btn = document.getElementById("logoutBtn");
    if (btn && !btn._navHandled) {
      btn._navHandled = true;
      btn.addEventListener("click", async function () {
        const tk = sessionStorage.getItem("token") || localStorage.getItem("token");
        if (tk) {
          try {
            const h = window.location.hostname;
            const isLocal = h === "localhost" || h === "127.0.0.1";
            const base = isLocal ? "" : "https://lively-reverence-production-def3.up.railway.app";
            await fetch(`${base}/api/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${tk}` } });
          } catch (_) { /* best-effort */ }
        }
        sessionStorage.clear();
        localStorage.removeItem("token");
        window.location.href = "/";
      });
    }

    // ── Pageview tracking (best-effort, non-blocking) ──
    const tk = sessionStorage.getItem("token") || localStorage.getItem("token");
    if (tk) {
      const h = window.location.hostname;
      const isLocal = h === "localhost" || h === "127.0.0.1";
      const base = isLocal ? "" : "https://lively-reverence-production-def3.up.railway.app";
      fetch(`${base}/api/audit/pageview`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${tk}` },
        body: JSON.stringify({ page: window.location.pathname })
      }).catch(() => {});
    }
  });
})();

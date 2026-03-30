/* nav.js – Sidebar Navigation – DMSKI Design System */
(function () {
  const role = sessionStorage.getItem("dmski_role") || localStorage.getItem("dmski_role") || "customer";
  const path = window.location.pathname;

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

  const icons = {
    dashboard: `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5L10 4l7 6.5"/><path d="M5 9v7h4v-4h2v4h4V9"/></svg>`,
    users:     `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/><path d="M2 17c0-3.314 3.582-5 8-5s8 1.686 8 5"/><path d="M16 7v4M18 9h-4"/></svg>`,
    profile:   `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="10" cy="7" r="3.5"/><path d="M3 17c0-3.314 3.134-6 7-6s7 2.686 7 6"/></svg>`,
    logout:    `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 10H3M7 6l-4 4 4 4"/><path d="M10 3h5a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-5"/></svg>`,
  };

  const adminBlock = role === "admin"
    ? `<span class="sb-section">Verwaltung</span>${sbLink("/users.html", "Benutzer", icons.users)}`
    : "";

  const sidebarHTML = `
    <aside class="dmski-sidebar" id="dmski-sidebar" role="navigation" aria-label="Hauptnavigation">
      <div class="sb-logo-area">
        <a href="/dashboard.html" class="sb-brand">
          <img src="/assets/logo-dmski_gold.png" alt="DMSKI" class="sb-logo" />
        </a>
        <p class="sb-tagline">Gerechtigkeit durch Mustererkennung.</p>
      </div>

      <nav class="sb-nav">
        <span class="sb-section">Plattform</span>
        ${sbLink("/dashboard.html", "Dashboard", icons.dashboard)}
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
      sub: "Dossiers verwalten — Neuen Fall anlegen oder bestehendes Dossier öffnen",
      icon: `<path d="M3 10.5L10 4l7 6.5"/><path d="M5 9v7h4v-4h2v4h4V9"/>`
    },
    "/files.html": {
      title: "Dossier-Analyse",
      sub: "Forensische Dokumentenanalyse — KI-gestützte Mustererkennung",
      icon: `<rect x="3" y="3" width="14" height="14" rx="2"/><path d="M7 7h6M7 10h4"/>`
    },
    "/users.html": {
      title: "Benutzerverwaltung",
      sub: "Alle Benutzer verwalten — Kunden & Fachpersonen",
      icon: `<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>`
    },
    // profile.html uses page-hero directly in HTML (with avatar/badge)
    "/upload.html": {
      title: "File Upload",
      sub: "Dokumente hochladen — automatische forensische Analyse",
      icon: `<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>`
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

  // Logout handler
  document.addEventListener("DOMContentLoaded", function () {
    const btn = document.getElementById("logoutBtn");
    if (btn && !btn._navHandled) {
      btn._navHandled = true;
      btn.addEventListener("click", function () {
        sessionStorage.clear();
        localStorage.removeItem("token");
        window.location.href = "/";
      });
    }
  });
})();

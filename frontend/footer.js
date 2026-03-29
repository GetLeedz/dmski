/* footer.js – Gemeinsamer Footer für alle DMSKI-Seiten */
(function () {
  const el = document.getElementById("site-footer");
  if (!el) return;

  // Hide footer on dashboard/app pages (logged-in area)
  const path = window.location.pathname;
  const isAppPage = ["/dashboard.html", "/files.html", "/upload.html", "/users.html", "/profile.html"].some(p => path.endsWith(p));
  if (isAppPage) {
    el.style.display = "none";
    return;
  }

  const year = new Date().getFullYear();
  const version = "1.0.0";

  const css = `
    #site-footer { margin-top: auto; }

    .dmski-footer {
      background: #0a0e17;
      color: rgba(255,255,255,.82);
      font-family: inherit;
      padding: 0;
      margin-top: 4rem;
      position: relative;
      overflow: hidden;
    }

    /* Neon accent line top */
    .dmski-footer::before {
      content: "";
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, #C5A059, #8b5cf6, #ec4899, #C5A059, transparent);
    }

    .dmski-footer-inner {
      max-width: 1100px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: 2.2fr 1fr 1fr;
      gap: 3rem;
      padding: 3.5rem 1.8rem 2.5rem;
    }

    @media (max-width: 680px) {
      .dmski-footer-inner {
        grid-template-columns: 1fr;
        gap: 2rem;
        padding: 2.5rem 1.2rem 2rem;
      }
    }

    .dmski-footer-logo {
      height: 2.2rem;
      filter: brightness(0) invert(1);
      opacity: .95;
      display: block;
      margin-bottom: .9rem;
    }

    .dmski-footer-tagline {
      font-size: .88rem;
      line-height: 1.6;
      margin: 0 0 1.2rem;
      color: rgba(255,255,255,.5);
    }

    .dmski-footer-ext {
      display: flex;
      gap: .7rem;
      flex-wrap: wrap;
    }

    .dmski-footer-ext a {
      font-size: .76rem;
      color: rgba(255,255,255,.45);
      text-decoration: none;
      border: 1px solid rgba(255,255,255,.12);
      border-radius: 999px;
      padding: .25rem .75rem;
      transition: all .18s;
    }

    .dmski-footer-ext a:hover {
      color: #fff;
      border-color: rgba(197,160,89,.5);
    }

    .dmski-footer-col strong {
      display: block;
      font-size: .65rem;
      letter-spacing: .1em;
      text-transform: uppercase;
      color: rgba(197,160,89,.6);
      margin-bottom: .9rem;
      font-weight: 700;
    }

    .dmski-footer-col a {
      display: block;
      font-size: .88rem;
      color: rgba(255,255,255,.6);
      text-decoration: none;
      margin-bottom: .6rem;
      transition: color .18s;
    }

    .dmski-footer-col a:hover { color: #fff; }

    .dmski-footer-bottom {
      max-width: 1100px;
      margin: 0 auto;
      padding: 1.2rem 1.8rem 1.5rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: .6rem;
      font-size: .75rem;
      color: rgba(255,255,255,.28);
      border-top: 1px solid rgba(255,255,255,.06);
    }

    .dmski-footer-bottom a {
      color: rgba(255,255,255,.4);
      text-decoration: none;
    }

    .dmski-footer-bottom a:hover { color: rgba(255,255,255,.8); }

    .dmski-footer-hosted {
      display: flex;
      align-items: center;
      gap: .35rem;
    }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  el.innerHTML = `
    <footer class="dmski-footer" role="contentinfo">
      <div class="dmski-footer-inner">
        <div class="dmski-footer-brand">
          <img src="/assets/logo-dmski.png" alt="DMSKI" class="dmski-footer-logo" />
          <p class="dmski-footer-tagline">Gerechtigkeit durch Mustererkennung.<br>KI-gestützte forensische Fallanalyse für Schweizer Recht.</p>
          <div class="dmski-footer-ext">
            <a href="https://www.getleedz.com" target="_blank" rel="noopener noreferrer">getleedz.com</a>
            <a href="https://www.aikmu.ch" target="_blank" rel="noopener noreferrer">aikmu.ch</a>
          </div>
        </div>

        <div class="dmski-footer-col">
          <strong>Plattform</strong>
          <a href="/dashboard.html">Dashboard</a>
          <a href="/profile.html">Mein Profil</a>
          <a href="/">Anmelden</a>
        </div>

        <div class="dmski-footer-col">
          <strong>Rechtliches</strong>
          <a href="/impressum.html">Impressum</a>
          <a href="/datenschutz.html">Datenschutz</a>
          <a href="/nutzungsbedingungen.html">Nutzungsbedingungen</a>
        </div>
      </div>

      <div class="dmski-footer-bottom">
        <span>&copy; ${year} GetLeedz GmbH &nbsp;&middot;&nbsp; <a href="https://dmski.ch">dmski.ch</a></span>
        <span class="dmski-footer-hosted">v${version} &nbsp;&middot;&nbsp; &#127464;&#127469; Daten in Z&uuml;rich &nbsp;&middot;&nbsp; &#127466;&#127482; Server in Amsterdam</span>
      </div>
    </footer>
  `;
})();

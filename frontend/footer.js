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
      background: linear-gradient(180deg, #0c1a30 0%, #091428 100%);
      color: rgba(255,255,255,.82);
      font-family: inherit;
      padding: 0;
      margin-top: 4rem;
      position: relative;
      overflow: hidden;
    }

    .dmski-footer-inner {
      max-width: 1100px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: 2fr 1fr;
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

    .dmski-footer-mail {
      font-size: .82rem;
      color: rgba(197,160,89,.7);
      text-decoration: none;
      letter-spacing: .02em;
      transition: color .18s;
    }
    .dmski-footer-mail:hover { color: #C5A059; }

    .dmski-footer-social {
      display: flex;
      align-items: center;
      gap: .6rem;
      margin-top: .6rem;
    }
    .dmski-footer-social a {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 2rem;
      height: 2rem;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,.1);
      background: rgba(255,255,255,.04);
      color: rgba(255,255,255,.5);
      text-decoration: none;
      transition: all .18s;
    }
    .dmski-footer-social a:hover {
      border-color: rgba(197,160,89,.4);
      color: #C5A059;
      background: rgba(197,160,89,.08);
    }
    .dmski-footer-social svg { width: 1rem; height: 1rem; fill: currentColor; }

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
          <p class="dmski-footer-tagline">DMSKI<br>KI-gestützte Aktenanalyse.</p>
          <a href="mailto:info@dmski.ch" class="dmski-footer-mail">info@dmski.ch</a>
          <div class="dmski-footer-social">
            <a href="https://www.facebook.com/profile.php?id=61574319811413" target="_blank" rel="noopener" aria-label="Facebook"><svg viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg></a>
            <a href="https://www.instagram.com/dmski_legal/" target="_blank" rel="noopener" aria-label="Instagram"><svg viewBox="0 0 24 24"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg></a>
          </div>
        </div>

        <div class="dmski-footer-col">
          <strong>Rechtliches</strong>
          <a href="/zugang.html">Zugang anfragen</a>
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

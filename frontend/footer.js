/* footer.js – Gemeinsamer Footer für alle DMSKI-Seiten */
(function () {
  const css = `
    #site-footer { margin-top: auto; }

    .dmski-footer {
      background: linear-gradient(135deg, #0a3d42 0%, #0d5760 60%, #116b73 100%);
      color: rgba(255,255,255,.82);
      font-family: inherit;
      padding: 2.8rem 1.5rem 0;
      margin-top: 3rem;
    }

    .dmski-footer-inner {
      max-width: 1100px;
      margin: 0 auto;
      display: grid;
      grid-template-columns: 2fr 1fr 1fr;
      gap: 2.5rem;
      padding-bottom: 2.2rem;
      border-bottom: 1px solid rgba(255,255,255,.12);
    }

    @media (max-width: 680px) {
      .dmski-footer-inner {
        grid-template-columns: 1fr 1fr;
      }
      .dmski-footer-brand { grid-column: 1 / -1; }
    }

    .dmski-footer-logo {
      height: 1.8rem;
      filter: brightness(0) invert(1);
      opacity: .92;
      display: block;
      margin-bottom: .7rem;
    }

    .dmski-footer-tagline {
      font-size: .82rem;
      line-height: 1.5;
      margin: 0 0 1rem;
      color: rgba(255,255,255,.65);
    }

    .dmski-footer-ext {
      display: flex;
      gap: .9rem;
      flex-wrap: wrap;
    }

    .dmski-footer-ext a {
      font-size: .78rem;
      color: rgba(255,255,255,.55);
      text-decoration: none;
      border: 1px solid rgba(255,255,255,.2);
      border-radius: 20px;
      padding: .18rem .65rem;
      transition: color .18s, border-color .18s;
    }

    .dmski-footer-ext a:hover {
      color: #fff;
      border-color: rgba(255,255,255,.5);
    }

    .dmski-footer-col strong {
      display: block;
      font-size: .72rem;
      letter-spacing: .06em;
      text-transform: uppercase;
      color: rgba(255,255,255,.4);
      margin-bottom: .75rem;
      font-weight: 600;
    }

    .dmski-footer-col a {
      display: block;
      font-size: .855rem;
      color: rgba(255,255,255,.78);
      text-decoration: none;
      margin-bottom: .45rem;
      transition: color .18s;
    }

    .dmski-footer-col a:hover { color: #fff; }

    .dmski-footer-bottom {
      max-width: 1100px;
      margin: 0 auto;
      padding: 1rem 0 1.4rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-wrap: wrap;
      gap: .5rem;
      font-size: .78rem;
      color: rgba(255,255,255,.38);
    }

    .dmski-footer-bottom a {
      color: rgba(255,255,255,.5);
      text-decoration: none;
    }

    .dmski-footer-bottom a:hover { color: rgba(255,255,255,.85); }

    .dmski-footer-hosted {
      display: flex;
      align-items: center;
      gap: .35rem;
    }
  `;
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const el = document.getElementById("site-footer");
  if (!el) return;

  const year = new Date().getFullYear();
  el.innerHTML = `
    <footer class="dmski-footer" role="contentinfo">
      <div class="dmski-footer-inner">
        <div class="dmski-footer-brand">
          <img src="/assets/logo-dmski.png" alt="DMSKI" class="dmski-footer-logo" />
          <p class="dmski-footer-tagline">KI-gestützte Fallanalyse<br>für Recht &amp; Beratung</p>
          <div class="dmski-footer-ext">
            <a href="https://www.getleedz.com" target="_blank" rel="noopener noreferrer">getleedz.com</a>
            <a href="https://www.aikmu.ch" target="_blank" rel="noopener noreferrer">aikmu.ch</a>
          </div>
        </div>

        <div class="dmski-footer-col">
          <strong>Plattform</strong>
          <a href="/dashboard.html">Dashboard</a>
          <a href="/profile.html">Mein Profil</a>
          <a href="/">Login</a>
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
        <span class="dmski-footer-hosted">&#127464;&#127469; Daten in Zürich &nbsp;&middot;&nbsp; &#127466;&#127482; Server in Amsterdam</span>
      </div>
    </footer>
  `;
})();

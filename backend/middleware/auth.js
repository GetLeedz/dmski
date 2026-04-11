/* backend/middleware/auth.js */
"use strict";

const jwt = require("jsonwebtoken");

/**
 * Prüft, ob ein gültiges JWT im Authorization-Header (Bearer) vorhanden ist.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    return res.status(401).json({ error: "Nicht autorisiert. Kein Token gefunden." });
  }

  try {
    // Verwendet das JWT_SECRET aus der Umgebungsvariable
    const payload = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret_change_this");
    
    // Payload (enthält sub, email, role) an das Request-Objekt hängen
    req.user = payload;
    next();
  } catch (err) {
    console.error("JWT Verification Error:", err.message);
    return res.status(401).json({ error: "Sitzung abgelaufen oder Token ungültig." });
  }
}

/**
 * Erlaubt den Zugriff nur, wenn der User die Rolle 'admin' hat.
 */
function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Administrator-Rechte erforderlich." });
  }
  next();
}

/**
 * Erlaubt Zugriff, wenn der User Admin ist ODER seine eigene ID aufruft.
 * Funktioniert sicher mit Zahlen (BigInt) und UUIDs (Strings).
 */
function requireAdminOrSelf(paramKey = "userId") {
  return (req, res, next) => {
    const isAdmin = req.user?.role === "admin";
    
    // Normalisierung der IDs zu kleingeschriebenen Strings für UUID-Kompatibilität
    const targetId = String(req.params[paramKey] || "").trim().toLowerCase();
    const currentUserId = String(req.user?.sub || "").trim().toLowerCase();

    // Validierung: Sind die IDs identisch?
    const isSelf = currentUserId !== "" && currentUserId === targetId;

    if (!isAdmin && !isSelf) {
      console.warn(`Zugriff verweigert: User ${currentUserId} wollte auf Ressource von ${targetId} zugreifen.`);
      return res.status(403).json({ error: "Keine Berechtigung für diese Ressource." });
    }
    
    next();
  };
}

/**
 * Case-Access-Middleware: Prüft ob der User Zugriff auf den Fall hat.
 *
 * mode = "read"  → admin, customer (alle), collaborator (nur zugewiesener Fall)
 * mode = "write" → admin, customer (alle), collaborator GESPERRT
 *
 * Erwartet :caseId als Route-Parameter.
 * Benötigt eine DB-Pool-Instanz via setCaseAccessPool().
 */
let _casePool = null;
function setCaseAccessPool(pool) { _casePool = pool; }

function requireCaseAccess(mode = "read") {
  return async (req, res, next) => {
    const role = req.user?.role;
    const caseId = String(req.params.caseId || "").trim();

    // Admin: full access
    if (role === "admin") return next();

    // Customer (Fallinhaber): full access only to own cases
    if (role === "customer") {
      if (_casePool && caseId) {
        try {
          const r = await _casePool.query("SELECT created_by FROM cases WHERE id = $1", [caseId]);
          if (r.rows.length && String(r.rows[0].created_by) === String(req.user.sub)) {
            return next();
          }
          // Also allow if user is a case_member
          const memberCheck = await _casePool.query(
            "SELECT id FROM case_members WHERE case_id = $1 AND user_id = $2",
            [caseId, req.user.sub]
          ).catch(() => ({ rows: [] }));
          if (memberCheck.rows.length) {
            if (mode === "write") {
              return res.status(403).json({ error: "Nur der Fall-Inhaber kann diese Aktion ausführen." });
            }
            return next();
          }
          return res.status(403).json({ error: "Kein Zugriff auf diesen Fall." });
        } catch (e) {
          console.error("Case owner check error:", e.message);
          return res.status(500).json({ error: "Berechtigungsprüfung fehlgeschlagen." });
        }
      }
      return next(); // No caseId in route — allow (e.g. listing cases)
    }

    // Collaborator (team): read-only on assigned case
    if (role === "collaborator") {
      if (mode === "write") {
        return res.status(403).json({ error: "Nur der Fall-Inhaber kann diese Aktion ausführen." });
      }
      // Check if this case is assigned to them
      if (_casePool && caseId) {
        try {
          const r = await _casePool.query("SELECT case_id FROM users WHERE id = $1", [req.user.sub]);
          const assigned = String(r.rows[0]?.case_id || "").trim();
          if (assigned && assigned === caseId) return next();
        } catch (e) {
          console.error("Case access check error:", e.message);
        }
      }
      return res.status(403).json({ error: "Kein Zugriff auf diesen Fall." });
    }

    // Unknown role
    return res.status(403).json({ error: "Keine Berechtigung." });
  };
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireAdminOrSelf,
  requireCaseAccess,
  setCaseAccessPool
};
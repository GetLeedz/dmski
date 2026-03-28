const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) {
    return res.status(401).json({ error: "Nicht autorisiert. Kein Token gefunden." });
  }

  try {
    // Falls JWT_SECRET in der .env fehlt, stürzt der Server hier nicht ab
    const payload = jwt.verify(token, process.env.JWT_SECRET || "fallback_secret_change_this");
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Sitzung abgelaufen oder Token ungültig." });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Administrator-Rechte erforderlich." });
  }
  next();
}

/**
 * Erlaubt Zugriff, wenn der User Admin ist ODER seine eigene ID aufruft.
 * Funktioniert jetzt sicher mit Zahlen (BigInt) und UUIDs (Strings).
 */
function requireAdminOrSelf(paramKey = "userId") {
  return (req, res, next) => {
    const isAdmin = req.user?.role === "admin";
    
    // Wir vergleichen als Strings, um Number/UUID Konflikte zu vermeiden
    const targetId = String(req.params[paramKey] || "");
    const currentUserId = String(req.user?.sub || "");

    const isSelf = currentUserId !== "" && currentUserId === targetId;

    if (!isAdmin && !isSelf) {
      console.warn(`Zugriff verweigert: User ${currentUserId} wollte auf Resource von ${targetId} zugreifen.`);
      return res.status(403).json({ error: "Keine Berechtigung für diese Ressource." });
    }
    next();
  };
}

module.exports = { requireAuth, requireAdmin, requireAdminOrSelf };
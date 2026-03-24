const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) {
    return res.status(401).json({ error: "Nicht autorisiert." });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ error: "Token ungueltig oder abgelaufen." });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Keine Administratorberechtigung." });
  }
  return next();
}

function requireAdminOrSelf(paramKey = "userId") {
  return (req, res, next) => {
    const targetId = Number(req.params[paramKey]);
    const isAdmin  = req.user?.role === "admin";
    const isSelf   = Number(req.user?.sub) === targetId;
    if (!isAdmin && !isSelf) {
      return res.status(403).json({ error: "Keine Berechtigung." });
    }
    return next();
  };
}

module.exports = { requireAuth, requireAdmin, requireAdminOrSelf };

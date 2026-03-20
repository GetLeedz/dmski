# DMSKI Site

Monorepo mit einfachem Node-Backend und statischem Frontend (Login UI).

## Struktur

- `backend`: Express API, Migrationen, Datenbank-Setup
- `frontend`: Statische Login-Seite mit modernem UI

## Voraussetzungen

- Node.js 20+
- npm 10+
- Optional: PostgreSQL fuer Migrationen

## Schnellstart

### 1) Abhaengigkeiten installieren

```bash
cd backend
npm install
cd ../frontend
npm install
```

### 2) Backend starten

```bash
cd backend
npm run dev
```

Backend Standard-URL:

- http://localhost:4000
- Health-Check: http://localhost:4000/health

### 3) Frontend starten

```bash
cd frontend
npm run dev
```

Frontend Standard-URL:

- http://localhost:5173

## Produktion (lokal)

Backend:

```bash
cd backend
npm start
```

Frontend:

```bash
cd frontend
npm start
```

## Datei-Uploads persistent speichern (Supabase Storage)

Dateien werden nicht mehr im Railway-Container gespeichert, sondern in Supabase Storage.

Benötigte Backend-Variablen (`backend/.env`):

```env
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
SUPABASE_STORAGE_BUCKET=case-files
```

Wichtig:

- Der Bucket (z.B. `case-files`) muss in Supabase existieren.
- Verwende den Service-Role-Key nur serverseitig im Backend, nie im Frontend.
- Uploads bleiben in Supabase persistent, auch bei Redeploy/Restart von Railway.

## Datenbank Migrationen

In `backend/.env` muss `DATABASE_URL` gesetzt sein.

Beispiel:

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/dmski
```

Migrationen ausfuehren:

```bash
cd backend
npm run migrate:up
```

Migration rueckgaengig:

```bash
npm run migrate:down
```

Neue Migration erstellen:

```bash
npm run migrate:create -- add_table_name
```

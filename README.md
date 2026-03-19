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

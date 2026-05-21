# Plataforma SASISOPA IA — Configuración técnica

Este paquete deja listo el backend para conectar la plataforma con Airtable, Google Drive, WhatsApp vía Twilio, OpenAI y n8n.

## Instalación

```bash
npm install
```

## Configuración

Copia `.env.example` como `.env` y pega tus credenciales reales.

```bash
cp .env.example .env
```

## Ejecutar

```bash
npm start
```

Servidor local:

```text
http://localhost:4000
```

Prueba:

```text
http://localhost:4000/api/health
```

## Tablas requeridas en Airtable

Crea una base llamada `SASISOPA Plataforma` con estas tablas:

- Estaciones
- Usuarios
- Obligaciones
- Evidencias
- Auditorias
- Hallazgos
- Incidentes

Puedes importar los CSV incluidos en la carpeta `airtable_import_csv`.

## Endpoints principales

- GET `/api/health`
- GET `/api/stations`
- POST `/api/stations`
- GET `/api/obligations`
- POST `/api/obligations`
- POST `/api/obligations/check-due`
- POST `/api/whatsapp/send`
- POST `/api/whatsapp/send-due-alert`
- POST `/api/evidence/upload`
- POST `/api/ai/classify-evidence`
- POST `/api/ai/generate-ied`
- POST `/api/audits/create`
- POST `/api/findings/create`
- GET `/api/findings`
- GET `/api/kpis/summary`

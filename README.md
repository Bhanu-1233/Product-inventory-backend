# Backend – Product Inventory API

## Tech

- Node.js + Express
- SQLite
- CSV import/export
- Inventory history tracking

## Setup

```bash
cd backend
cp .env.example .env
npm install
npm run dev   # or: npm start
```

By default the API runs on `http://localhost:4000`.

## Environment variables

- `PORT` – port number (default: 4000)
- `DATABASE_FILE` – path to SQLite database file (default: `./database.sqlite`)
- `CORS_ORIGIN` – comma-separated list of allowed frontend origins  
  Example: `http://localhost:5173,https://your-frontend.vercel.app`

## Main endpoints

- `GET /api/products`
- `GET /api/products/search?name=abc`
- `POST /api/products`
- `PUT /api/products/:id`
- `DELETE /api/products/:id`
- `GET /api/products/:id/history`
- `POST /api/products/import` (multipart/form-data, field name: `file`)
- `GET /api/products/export`
```


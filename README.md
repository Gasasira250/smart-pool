# Smart Pool

Desk and floor office for six pool tables: simulated MTN and Airtel payments, live scores, offline pocket queue, and pocket installation.

## Run it on this computer

1. Copy `backend/.env.example` to `backend/.env` and set `PGPASSWORD` and `ADMIN_KEY`.
2. Create the database role if it does not exist, then apply the schema:

```powershell
cd backend
npm install
npm run init-db
```

3. Install and build the desk:

```powershell
cd ..\frontend
npm install
npm run build
```

4. Start the API. It serves the built desk:

```powershell
cd ..\backend
node .\src\server.js
```

Open http://127.0.0.1:5000/ for the table desk and http://127.0.0.1:5000/admin for the floor office. Enter `ADMIN_KEY` on the admin page and click Unlock.

`curl.exe http://127.0.0.1:5000/health` still returns JSON.

## Development

The React dev server is http://127.0.0.1:5173/ and proxies the API on port 5000:

```powershell
cd frontend
npm run dev
```

## Tests

```powershell
cd backend
npm test
```

Payments stay in simulation until MTN and Airtel keys are filled in `backend/.env`. A phone number ending in 0 is declined. The database password and admin key stay in `.env` and are not part of this repository.

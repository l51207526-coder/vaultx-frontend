# VaultX frontend

Static frontend for the VaultX local development build.

## Run

From this folder:

```powershell
npx.cmd serve .
```

Open `http://localhost:3000`.

By default, the frontend expects the backend API at `http://localhost:4000`.
For another environment, set `window.VAULTX_API_BASE` to the backend origin
before `app.js` loads (for example, `https://api.example.com`). Configure the
backend's `FRONTEND_ORIGIN` to the deployed frontend origin as well.

The UI keeps the existing VaultX design but now reads wallet balances, transactions, withdrawals and VIP funding from the backend rather than maintaining a fake browser-side balance.
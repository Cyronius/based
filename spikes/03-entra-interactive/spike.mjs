// Phase 0 spike #3 — Entra ID interactive browser auth end-to-end under Bun.
// REQUIRES A HUMAN: launches the system default browser for Entra sign-in and
// catches the OAuth redirect on a loopback HTTP listener (both handled inside
// @azure/identity's InteractiveBrowserCredential).
//
// Run:  bun run spike.mjs        (also try: node spike.mjs as a control)
// Pass: browser opens -> sign in -> token acquired -> tedious connects -> SELECT 1.
// Fail modes to watch: loopback listener never starts under Bun, browser not
// launched, token acquired but tedious rejects it.

import sql from 'mssql';
import { InteractiveBrowserCredential } from '@azure/identity';

const RUNTIME = typeof Bun !== 'undefined' ? `bun ${Bun.version}` : `node ${process.version}`;
const SERVER = process.env.SPIKE_SQL_SERVER || 'zl5qolt7t8.database.windows.net';
const DATABASE = process.env.SPIKE_SQL_DB || 'learnermobile_db_ci';
console.log(`runtime: ${RUNTIME}`);

// Uses the well-known Azure CLI public client id so no app registration is
// needed; the redirect goes to a random localhost port's loopback listener.
const cred = new InteractiveBrowserCredential({
  clientId: '04b07795-8ddb-461a-bbee-02f9e1bf7b46', // Azure CLI public client
  redirectUri: 'http://localhost:8400',
  loginHint: process.env.SPIKE_LOGIN_HINT || 'josh.attoun@sviworld.com',
});

console.log('Launching system browser for Entra sign-in (waiting up to 3 min)...');
const t0 = Date.now();
const tokenRes = await cred.getToken('https://database.windows.net/.default');
console.log(`TOKEN_OK in ${Date.now() - t0}ms (expires ${new Date(tokenRes.expiresOnTimestamp).toISOString()})`);

const pool = await new sql.ConnectionPool({
  server: SERVER,
  database: DATABASE,
  options: { encrypt: true },
  authentication: { type: 'azure-active-directory-access-token', options: { token: tokenRes.token } },
  connectionTimeout: 30000,
}).connect();
const r = await pool.request().query('SELECT SUSER_SNAME() AS who, 1 AS ok');
console.log(`CONNECT_OK as ${r.recordset[0].who}`);
await pool.close();
console.log('SPIKE 3 PASS');

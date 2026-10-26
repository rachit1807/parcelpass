import 'dotenv/config';
import { createStore } from './db.js';
import { createApp } from './app.js';
const production = process.env.NODE_ENV === 'production';
if (production && !process.env.DATABASE_URL) throw new Error('Production requires a persistent PostgreSQL DATABASE_URL.');
const store = await createStore({ url: process.env.DATABASE_URL });
const app = createApp({ store, secret: process.env.JWT_SECRET, production, origin: process.env.APP_ORIGIN, tokenExpiry: process.env.JWT_EXPIRES_IN || '30m' });
const server = app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('ParcelPass is ready.'));
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(async () => { await store.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 25000).unref();
}
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);

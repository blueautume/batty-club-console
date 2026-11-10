import { createApp } from './app.ts';

const port = Number(process.env.PORT || 4318);
const host = process.env.HOST || '127.0.0.1';
const service = createApp();
const server = service.app.listen(port, host, () => {
  console.log(`Batty Club local console: http://${host}:${port}`);
  console.log(`Persistent database: ${service.dbPath}`);
});
function shutdown() { server.close(() => { service.close(); process.exit(0); }); }
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

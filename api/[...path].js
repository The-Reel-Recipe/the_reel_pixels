/* Vercel serverless entry — kept only until the cutover in RUNBOOK.md,
   and no longer a supported way to run this.

   The server stopped being stateless several phases ago. It holds the wall
   in memory, runs the Telegram outbox worker on an interval, sweeps expired
   payment holds on another, and keeps every SSE client on one process.
   Serverless runs N instances of that by definition, and N instances means
   N divergent wall caches, N allowance ledgers and N workers racing the same
   queue — at which point the cells primary key is the *only* thing still
   holding the design together (PLAN §4.1: single writer process).

   So this file is a redirect waiting to happen rather than a deployment.
   The boot warns loudly if it ever runs; the cutover step in the runbook is
   to point the Vercel project at the VPS and delete this directory. */
const app = require('../server.js');

if (process.env.VERCEL) {
  console.warn('\n  ⚠  This build is running on Vercel, which cannot host it correctly.\n' +
    '     The wall cache, the moderation queue worker and the payment sweeper all\n' +
    '     assume one long-lived process. See RUNBOOK.md → cutover.\n');
}

module.exports = app;

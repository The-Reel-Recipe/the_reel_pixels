/* Vercel serverless entry.

   A catch-all so every /api/* request lands here with its original path
   intact in req.url — server.js routes on that, exactly as it does behind
   `node server.js` locally. Deliberately not a vercel.json rewrite: a
   rewrite can hand the function the destination path instead of the one
   the caller asked for, which would 404 every route.

   Static files are served by Vercel's CDN in this deployment, so
   serveStatic() in server.js only ever runs in local dev. */
module.exports = require('../server.js');

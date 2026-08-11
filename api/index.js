/* Vercel serverless entry.

   vercel.json rewrites /api/* here; server.js does the routing, exactly as it
   does behind `node server.js` locally. Static files are served by Vercel's
   CDN in this deployment, so serveStatic() only ever runs in local dev. */
module.exports = require('../server.js');

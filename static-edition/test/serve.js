// static file server for the built site, with an optional config.js override (so tests can point the site at a fake Supabase)
const http = require('http'), fs = require('fs'), path = require('path');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.pdf': 'application/pdf' };
module.exports = (dist, port, configJs) => new Promise((resolve) => { const srv = http.createServer((q, r) => { const p = decodeURIComponent(q.url.split('?')[0]);
  if (configJs && p === '/config.js') { r.writeHead(200, { 'Content-Type': 'text/javascript' }); return r.end(configJs); }
  let f = path.join(dist, p); if (f.endsWith('/')) f += 'index.html'; fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'Content-Type': mime[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); });
  srv.listen(port, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, close: () => new Promise((x) => srv.close(x)) })); });

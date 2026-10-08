const http = require('http');
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '..', 'frontend', 'index.html');
const apiBase = JSON.stringify(process.env.API_BASE_URL || '').replace(/</g, '\\u003c');
const html = fs.readFileSync(htmlPath, 'utf8').replace('__API_BASE_URL__', apiBase);
const port = Number.parseInt(process.env.FRONTEND_PORT || '3000', 10);

http.createServer((req, res) => {
  if (req.method !== 'GET' || (req.url !== '/' && req.url !== '/index.html')) {
    res.writeHead(404);
    return res.end('Not found');
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}).listen(port, () => {
  console.log(`🌐 Frontend running on http://localhost:${port}`);
});

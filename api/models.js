// Vercel serverless function: list model yang tersedia di UI.
// Setara dengan api/models.php tapi runtime Node.js.

'use strict';

const { loadConfig } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).send(JSON.stringify({ ok: false, error: 'Method not allowed' }));
    return;
  }
  const cfg = loadConfig();
  res.status(200).send(JSON.stringify({
    ok: true,
    models: cfg.allowed_models,
    default: cfg.default_model,
  }));
};

'use strict';
// Vercel entry: every dynamic route (see vercel.json rewrites) lands here. Static pages come from public/.
const { loadConfig, configProblems } = require('../lib/config');
const { createUpstashStore } = require('../lib/store');
const { createRelay } = require('../lib/app');
const { sendJson } = require('../lib/http');

let handler = null;
module.exports = async (req, res) => {
  if (!handler) {
    const config = loadConfig();
    const problems = configProblems(config);
    if (problems.length) {
      console.error('relay misconfigured: ' + problems.join('; '));
      return sendJson(res, 503, { error: 'relay not configured' });
    }
    handler = createRelay({ config, store: createUpstashStore(config.upstash) });
  }
  return handler(req, res);
};

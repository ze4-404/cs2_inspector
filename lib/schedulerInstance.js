const config = require("../config");
const { createLongestIdleScheduler } = require("./scheduler");

function proxyFor(i, proxies) {
  if (!proxies || proxies.length === 0) return null;
  return proxies[i % proxies.length];
}

const accounts = Array.isArray(config.logins) ? config.logins : [];
const proxies = Array.isArray(config.proxies) ? config.proxies : [];

const pool = accounts.map((a, i) => ({
  id: a.user,
  account: a,
  proxy: proxyFor(i, proxies),
  busy: false,
  lastReleaseAt: 0,
  nextAvailableAt: 0
}));

const scheduler = createLongestIdleScheduler(pool, () => Date.now(), {
  cooldownMs: (config.scheduler && config.scheduler.cooldownMs) || 1100
});

module.exports = { scheduler, pool };

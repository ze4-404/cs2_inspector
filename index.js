const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const config = require("./config");
const { scheduler, pool } = require("./lib/schedulerInstance");

const app = express();
app.use(cors({ origin: (origin, cb) => cb(null, true), credentials: true }));
app.use(bodyParser.json({ limit: "1mb" }));
app.set("trust proxy", !!config.trust_proxy);

const PORT = (config.http && config.http.port) || 80;
const MAX_SIM_REQ = typeof config.max_simultaneous_requests === "number" ? config.max_simultaneous_requests : -1;

function createLimiter(limit) {
  let active = 0;
  const q = [];
  const runNext = () => {
    if (limit >= 0 && active >= limit) return;
    const next = q.shift();
    if (!next) return;
    active++;
    next()
      .catch(() => {})
      .finally(() => {
        active--;
        runNext();
      });
  };
  const schedule = (fn) =>
    new Promise((resolve, reject) => {
      const task = async () => {
        try {
          const r = await fn();
          resolve(r);
        } catch (e) {
          reject(e);
        }
      };
      if (limit < 0 || active < limit) {
        active++;
        task()
          .catch(() => {})
          .finally(() => {
            active--;
            runNext();
          });
      } else {
        q.push(task);
      }
    });
  return {
    schedule,
    active: () => active,
    queued: () => q.length,
  };
}

const limiter = createLimiter(MAX_SIM_REQ);

let inspectImpl = null;
let inspectImplName = null;

function resolveInspectImpl() {
  if (inspectImpl) return;
  const candidates = [
    "./lib/inspect",
    "./lib/steam",
    "./src/inspect",
    "./lib/runInspect",
    "./inspector",
  ];
  const fnNames = ["inspectWithPair", "inspectLink", "inspect", "run", "performInspect"];
  for (const mod of candidates) {
    try {
      const m = require(mod);
      for (const name of fnNames) {
        if (m && typeof m[name] === "function") {
          inspectImpl = m[name];
          inspectImplName = `${mod}.${name}`;
          return;
        }
      }
      if (typeof m === "function") {
        inspectImpl = m;
        inspectImplName = `${mod} (default export)`;
        return;
      }
    } catch (_) {}
  }
}

async function performInspect(pair, url) {
  resolveInspectImpl();
  if (!inspectImpl) {
    const err = new Error("Inspect implementation not found");
    err.code = "INSPECT_IMPL_MISSING";
    throw err;
  }
  try {
    if (inspectImpl.length >= 3) {
      return await inspectImpl(pair.account, pair.proxy, url);
    }
    if (inspectImpl.length === 2) {
      return await inspectImpl(pair, url);
    }
    if (inspectImpl.length === 1) {
      return await inspectImpl(url);
    }
    return await inspectImpl({ account: pair.account, proxy: pair.proxy, url });
  } catch (e) {
    throw e;
  }
}

function normalizeLink(x) {
  if (!x) return null;
  if (typeof x === "string") return x;
  if (x.url) return x.url;
  if (x.link) return x.link;
  return null;
}

app.get("/", async (req, res) => {
  const url = req.query && req.query.url;
  if (!url) return res.status(400).json({ error: "Missing url", code: 2, status: 400 });
  const run = async () => {
    const pair = scheduler.take();
    if (!pair) return res.status(503).json({ error: "No bots available", code: 6, status: 503 });
    try {
      const data = await performInspect(pair, url);
      scheduler.release(pair);
      return res.json(data);
    } catch (e) {
      scheduler.failWithBackoff(pair, 3000);
      const status = e && e.statusCode ? e.statusCode : 500;
      return res.status(status).json({ error: e && e.message ? e.message : "Internal error", code: 6, status });
    }
  };
  try {
    await limiter.schedule(run);
  } catch (e) {
    return res.status(500).json({ error: "Internal error", code: 6, status: 500 });
  }
});

app.post("/bulk", async (req, res) => {
  const list = (req.body && req.body.links) || [];
  if (!Array.isArray(list) || list.length === 0) return res.json({});
  const outputs = {};
  await Promise.all(
    list.map((item) => {
      const link = normalizeLink(item);
      if (!link) {
        return Promise.resolve();
      }
      return limiter.schedule(async () => {
        const pair = scheduler.take();
        if (!pair) {
          outputs[link] = { error: "No bots available", code: 6, status: 503 };
          return;
        }
        try {
          const data = await performInspect(pair, link);
          scheduler.release(pair);
          outputs[link] = data;
        } catch (e) {
          scheduler.failWithBackoff(pair, 3000);
          outputs[link] = { error: e && e.message ? e.message : "Internal error", code: 6, status: 500 };
        }
      });
    })
  );
  res.json(outputs);
});

app.get("/stats", (req, res) => {
  const free = pool.filter((p) => !p.busy);
  const freeLasts = free.map((p) => p.lastReleaseAt).filter(Boolean);
  const oldestIdleMs = freeLasts.length ? Math.max(0, Date.now() - Math.min(...freeLasts)) : 0;
  const botsOnline = pool.length - pool.filter((p) => p.busy).length;
  res.json({
    bots_online: botsOnline,
    bots_total: pool.length,
    queue_size: limiter.queued(),
    queue_concurrency: MAX_SIM_REQ,
    scheduler_policy: (config.scheduler && config.scheduler.policy) || "longestIdle",
    oldest_idle_ms: oldestIdleMs,
    impl: inspectImplName || null,
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  process.stdout.write(`inspector listening on ${PORT}\n`);
});

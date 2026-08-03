"use strict";
/**
 * Сервер CRM медичної частини.
 * Віддає застосунок і зберігає його стан у спільному сховищі,
 * щоб усі підрозділи бачили одні й ті самі залишки.
 *
 * Змінні середовища:
 *   APP_PASSWORD    — спільний пароль доступу до сайту (обов'язково)
 *   SESSION_SECRET  — ключ підпису cookie (Render згенерує сам)
 *   DATABASE_URL    — Postgres; якщо не задано, стан пишеться у файл DATA_DIR/kv.json
 *   DATA_DIR        — тека для файлового сховища (типово ./data)
 */

const express = require("express");
const crypto  = require("crypto");
const fs      = require("fs");
const fsp     = require("fs/promises");
const path    = require("path");

const PORT     = process.env.PORT || 3000;
const PASS     = process.env.APP_PASSWORD;
const SECRET   = process.env.SESSION_SECRET || "";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const TTL      = 12 * 3600 * 1000;              // сесія браузера — 12 годин

if (!PASS) {
  console.error("\n[!] Не задано APP_PASSWORD. Додайте змінну середовища у налаштуваннях сервісу Render і перезапустіть деплой.\n");
  process.exit(1);
}
if (!SECRET) {
  console.warn("[!] SESSION_SECRET не задано — cookie підписуються тимчасовим ключем, після перезапуску всі вийдуть із системи.");
}
const KEY = SECRET || crypto.randomBytes(32).toString("hex");

/* ------------------------------------------------------------------ */
/*  Сховище: Postgres або локальний файл                               */
/* ------------------------------------------------------------------ */

function fileStore() {
  const file = path.join(DATA_DIR, "kv.json");
  let cache = null, chain = Promise.resolve();

  const read = async () => {
    if (cache) return cache;
    try { cache = JSON.parse(await fsp.readFile(file, "utf8")); }
    catch { cache = {}; }
    return cache;
  };
  const flush = async () => {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    const tmp = file + ".tmp";
    await fsp.writeFile(tmp, JSON.stringify(cache));
    await fsp.rename(tmp, file);                 // атомарний запис
  };
  const queue = fn => (chain = chain.then(fn, fn));

  return {
    kind: "файл " + file,
    async init() { await fsp.mkdir(DATA_DIR, { recursive: true }); await read(); },
    async get(key) { const db = await read(); return db[key] || null; },
    async list(prefix) {
      const db = await read();
      return Object.keys(db).filter(k => !prefix || k.startsWith(prefix));
    },
    async put(key, value, rev) {
      return queue(async () => {
        const db = await read();
        const cur = db[key];
        if (rev != null && cur && cur.rev !== rev) return { conflict: true, current: cur };
        const next = { value, rev: (cur ? cur.rev : 0) + 1, at: Date.now() };
        db[key] = next; await flush();
        return { rev: next.rev };
      });
    },
    async del(key) {
      return queue(async () => { const db = await read(); delete db[key]; await flush(); return true; });
    },
    async dump() { return read(); }
  };
}

function pgStore() {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 4
  });
  return {
    kind: "Postgres",
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS kv (
        key text PRIMARY KEY,
        value text NOT NULL,
        rev integer NOT NULL DEFAULT 1,
        updated_at timestamptz NOT NULL DEFAULT now()
      )`);
    },
    async get(key) {
      const r = await pool.query("SELECT value, rev FROM kv WHERE key=$1", [key]);
      return r.rows[0] || null;
    },
    async list(prefix) {
      const r = prefix
        ? await pool.query("SELECT key FROM kv WHERE key LIKE $1 ORDER BY key", [prefix + "%"])
        : await pool.query("SELECT key FROM kv ORDER BY key");
      return r.rows.map(x => x.key);
    },
    async put(key, value, rev) {
      if (rev == null) {
        const r = await pool.query(
          `INSERT INTO kv (key, value, rev) VALUES ($1,$2,1)
           ON CONFLICT (key) DO UPDATE SET value=$2, rev=kv.rev+1, updated_at=now()
           RETURNING rev`, [key, value]);
        return { rev: r.rows[0].rev };
      }
      const r = await pool.query(
        `UPDATE kv SET value=$2, rev=rev+1, updated_at=now() WHERE key=$1 AND rev=$3 RETURNING rev`,
        [key, value, rev]);
      if (r.rowCount) return { rev: r.rows[0].rev };
      const cur = await this.get(key);
      if (!cur) {                                   // ключа ще немає — створюємо
        const ins = await pool.query("INSERT INTO kv (key,value,rev) VALUES ($1,$2,1) RETURNING rev", [key, value]);
        return { rev: ins.rows[0].rev };
      }
      return { conflict: true, current: cur };
    },
    async del(key) { await pool.query("DELETE FROM kv WHERE key=$1", [key]); return true; },
    async dump() {
      const r = await pool.query("SELECT key, value, rev FROM kv");
      const out = {}; r.rows.forEach(x => out[x.key] = { value: x.value, rev: x.rev });
      return out;
    }
  };
}

const store = process.env.DATABASE_URL ? pgStore() : fileStore();

/* ------------------------------------------------------------------ */
/*  Шлюз доступу                                                       */
/* ------------------------------------------------------------------ */

const sign = txt => crypto.createHmac("sha256", KEY).update(txt).digest("hex").slice(0, 32);

function makeToken() {
  const exp = Date.now() + TTL;
  return exp + "." + sign(String(exp));
}
function validToken(tok) {
  if (!tok) return false;
  const [exp, mac] = String(tok).split(".");
  if (!exp || !mac) return false;
  if (Number(exp) < Date.now()) return false;
  const a = Buffer.from(mac), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(p => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
const authed = req => validToken(cookies(req).med_gate);

function gate(req, res, next) {
  if (authed(req)) return next();
  res.status(401).json({ error: "Потрібен вхід" });
}

/* ------------------------------------------------------------------ */
/*  Маршрути                                                           */
/* ------------------------------------------------------------------ */

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "6mb" }));

// проста заслінка від підбору пароля
const tries = new Map();
app.post("/api/gate", (req, res) => {
  const ip = req.ip || "?";
  const t = tries.get(ip) || { n: 0, until: 0 };
  if (Date.now() < t.until) return res.status(429).json({ error: "Забагато спроб, зачекайте хвилину" });

  const given = Buffer.from(String((req.body && req.body.password) || ""));
  const real  = Buffer.from(PASS);
  const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
  if (!ok) {
    t.n++; if (t.n >= 6) { t.until = Date.now() + 60000; t.n = 0; }
    tries.set(ip, t);
    return res.status(403).json({ error: "Пароль невірний" });
  }
  tries.delete(ip);
  res.setHeader("Set-Cookie",
    `med_gate=${makeToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL / 1000}` +
    (process.env.NODE_ENV === "development" ? "" : "; Secure"));
  res.json({ ok: true });
});

app.post("/api/logout", (req, res) => {
  res.setHeader("Set-Cookie", "med_gate=; Path=/; HttpOnly; Max-Age=0");
  res.json({ ok: true });
});

// key-value для стану застосунку
app.get("/api/kv", gate, async (req, res) => {
  res.json({ keys: await store.list(req.query.prefix || "") });
});
app.get("/api/kv/:key", gate, async (req, res) => {
  const r = await store.get(req.params.key);
  if (!r) return res.status(404).json({ error: "Ключа немає" });
  res.json({ key: req.params.key, value: r.value, rev: r.rev });
});
app.get("/api/rev/:key", gate, async (req, res) => {
  const r = await store.get(req.params.key);
  res.json({ rev: r ? r.rev : 0 });
});
app.put("/api/kv/:key", gate, async (req, res) => {
  const { value, rev } = req.body || {};
  if (typeof value !== "string") return res.status(400).json({ error: "Очікується текстове значення" });
  const r = await store.put(req.params.key, value, rev == null ? null : Number(rev));
  if (r.conflict) return res.status(409).json({ error: "Дані змінив інший користувач", rev: r.current.rev });
  res.json({ key: req.params.key, rev: r.rev });
});
app.delete("/api/kv/:key", gate, async (req, res) => {
  await store.del(req.params.key);
  res.json({ key: req.params.key, deleted: true });
});

// резервна копія всієї бази одним файлом
app.get("/api/backup", gate, async (req, res) => {
  const dump = await store.dump();
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition",
    `attachment; filename="med-crm-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify({ exportedAt: new Date().toISOString(), data: dump }, null, 2));
});

// відновлення з резервної копії
app.post("/api/restore", gate, async (req, res) => {
  const data = req.body && req.body.data;
  if (!data || typeof data !== "object") return res.status(400).json({ error: "Очікується поле data" });
  let n = 0;
  for (const [key, rec] of Object.entries(data)) {
    const value = typeof rec === "string" ? rec : rec && rec.value;
    if (typeof value === "string") { await store.put(key, value, null); n++; }
  }
  res.json({ restored: n });
});

app.get("/healthz", (req, res) => res.type("text").send("ok"));

// сторінки
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/", (req, res) => {
  if (!authed(req)) return res.redirect("/login");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
app.use(express.static(path.join(__dirname, "public"), { index: false }));

store.init()
  .then(() => app.listen(PORT, () => console.log(`CRM медичної частини слухає порт ${PORT}; сховище: ${store.kind}`)))
  .catch(e => { console.error("Не вдалося підготувати сховище:", e); process.exit(1); });

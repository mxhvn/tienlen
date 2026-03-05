// worker.js — TLMN Tournament PRO (DEMO) — D1 + GitHub Pages
// Binding: env.DB (D1Database)
//
// Money rules (VND):
// - NORMAL: last->first 20k; third->second 10k
// - WHITE: winner gets 20k from each other (3×20k); no ranks
// - KILL: each victim pays killer 40k (NO extra bet)
// - PIG CUT: 1 pig = 10k, enter qty; victim pays cutter qty*10k
//
// Score rules:
// - NORMAL ranks: 1st +2, 2nd +1, 3rd -1, last -2
// - PIG CUT: cutter +qty, victim -qty
// - KILL: killer +4 per victim, each victim -4
// - WHITE: winner +6, each other -2
//
// Pro features: undo last round, ledger endpoint, scoreboard in stats.

const ALLOW_ORIGINS = [
  "https://mxhvn.github.io",
  "https://b1mmm.github.io",
  "https://safevuln.github.io",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

const RULES = Object.freeze({
  third_to_second: 10_000,
  last_to_first: 20_000,
  white_bonus_per_player: 20_000,
  kill_per_victim: 40_000,
  pig_unit: 10_000, // ✅ new
});

// --------- CORS ----------
function pickOrigin(req) {
  const origin = req.headers.get("Origin") || "";
  if (ALLOW_ORIGINS.includes(origin)) return origin;
  if (/^https:\/\/[a-z0-9-]+\.github\.io$/i.test(origin)) return origin;
  return ALLOW_ORIGINS[0] || "*";
}
function corsHeaders(req) {
  const allow = pickOrigin(req);
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
function withCors(req, res) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(corsHeaders(req))) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

// --------- Helpers ----------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}
function uid(prefix = "") {
  return `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}
function safeJsonArray(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
function isDistinct(arr) {
  const a = arr.filter(Boolean);
  return new Set(a).size === a.length;
}
function ensureDB(env) {
  if (!env || !env.DB || typeof env.DB.prepare !== "function") {
    return {
      ok: false,
      error:
        "D1 binding missing. Please bind a D1 database with variable name 'DB' in Worker settings (Bindings) or wrangler.toml.",
    };
  }
  return { ok: true };
}

// --------- Core DB reads ----------
async function getSessionRow(env, sessionId) {
  return await env.DB.prepare(`SELECT * FROM sessions WHERE id=?`).bind(sessionId).first();
}
function parseSession(row) {
  return {
    id: row.id,
    created_at: row.created_at,
    ended_at: row.ended_at,
    title: row.title,
    currency: row.currency || "VND",
    players: JSON.parse(row.players_json || "[]"),
    is_locked: !!row.is_locked,
  };
}
async function getBalances(env, sessionId) {
  const q = `
    SELECT player, COALESCE(SUM(delta),0) AS balance
    FROM ledger
    WHERE session_id = ?
    GROUP BY player
  `;
  const { results } = await env.DB.prepare(q).bind(sessionId).all();
  const map = {};
  for (const r of results) map[r.player] = Number(r.balance || 0);
  return map;
}
function computeSettlement(players, balances) {
  const creditors = [];
  const debtors = [];
  for (const p of players) {
    const b = Number(balances?.[p] || 0);
    if (b > 0) creditors.push({ p, amt: b });
    else if (b < 0) debtors.push({ p, amt: -b });
  }
  const transfers = [];
  let i = 0, j = 0;
  while (i < debtors.length && j < creditors.length) {
    const d = debtors[i];
    const c = creditors[j];
    const pay = Math.min(d.amt, c.amt);
    transfers.push({ from: d.p, to: c.p, amount: pay });
    d.amt -= pay;
    c.amt -= pay;
    if (d.amt <= 1e-7) i++;
    if (c.amt <= 1e-7) j++;
  }
  return transfers;
}

async function getRounds(env, sessionId, limit = 150, order = "DESC") {
  const ord = (order === "ASC") ? "ASC" : "DESC";
  const { results } = await env.DB.prepare(
    `SELECT id, session_id, idx, created_at, mode,
            first_player, second_player, third_player, last_player,
            white_winner, victims_json, note
     FROM rounds
     WHERE session_id=?
     ORDER BY idx ${ord}
     LIMIT ?`
  ).bind(sessionId, limit).all();
  return results;
}

// --------- Stats (rank counters for internal use) ----------
function makeEmptyStats(players) {
  const base = {};
  for (const p of players) {
    base[p] = {
      rounds: 0,
      first: 0, second: 0, third: 0, last: 0,
      white_wins: 0,
      kills_made: 0,
      killed_victims: 0,
      killed_times: 0,
    };
  }
  return base;
}
function computeStats(players, roundsAsc) {
  const s = makeEmptyStats(players);
  for (const r of roundsAsc) {
    for (const p of players) s[p].rounds += 1;

    if (r.mode === "WHITE") {
      const w = r.white_winner;
      if (s[w]) s[w].white_wins += 1;
      continue;
    }

    if (r.first_player && s[r.first_player]) s[r.first_player].first += 1;
    if (r.second_player && s[r.second_player]) s[r.second_player].second += 1;
    if (r.third_player && s[r.third_player]) s[r.third_player].third += 1;
    if (r.last_player && s[r.last_player]) s[r.last_player].last += 1;

    if (r.mode === "KILL") {
      const victims = safeJsonArray(r.victims_json);
      const killer = r.first_player;
      if (killer && s[killer]) {
        s[killer].kills_made += 1;
        s[killer].killed_victims += victims.length;
      }
      for (const v of victims) if (s[v]) s[v].killed_times += 1;
    }
  }
  return s;
}
function computeMVP(players, balances, scoreByPlayer) {
  const rows = players.map(p => ({
    p,
    net: Number(balances?.[p] || 0),
    score: Number(scoreByPlayer?.[p] || 0),
  }));
  rows.sort((a, b) => {
    if (b.net !== a.net) return b.net - a.net;       // primary: money
    if (b.score !== a.score) return b.score - a.score; // secondary: score
    return a.p.localeCompare(b.p);
  });
  return rows[0] || null;
}

// --------- Score engine ----------
function scoreInit(players) {
  const s = {};
  for (const p of players) s[p] = 0;
  return s;
}
function addScore(scores, player, delta) {
  if (!player) return;
  if (scores[player] === undefined) scores[player] = 0;
  scores[player] += Number(delta || 0);
}
async function computeScoreByPlayer(env, sessionId, players) {
  const scores = scoreInit(players);

  const { results: rounds } = await env.DB.prepare(
    `SELECT id, idx, mode, first_player, second_player, third_player, last_player,
            white_winner, victims_json
     FROM rounds
     WHERE session_id=?
     ORDER BY idx ASC`
  ).bind(sessionId).all();

  // cuts are allowed in NORMAL/KILL only
  const { results: cuts } = await env.DB.prepare(
    `SELECT round_id, cutter, victim, qty
     FROM cuts
     WHERE session_id=?`
  ).bind(sessionId).all();

  const cutsByRound = new Map();
  for (const c of cuts) {
    const rid = c.round_id;
    if (!cutsByRound.has(rid)) cutsByRound.set(rid, []);
    cutsByRound.get(rid).push(c);
  }

  for (const r of rounds) {
    const mode = String(r.mode || "").toUpperCase();

    if (mode === "WHITE") {
      const w = r.white_winner;
      addScore(scores, w, +6);
      for (const p of players) {
        if (p !== w) addScore(scores, p, -2);
      }
      continue;
    }

    if (mode === "NORMAL") {
      addScore(scores, r.first_player, +2);
      addScore(scores, r.second_player, +1);
      addScore(scores, r.third_player, -1);
      addScore(scores, r.last_player, -2);
    }

    if (mode === "KILL") {
      const killer = r.first_player;
      let victims = [];
      try { victims = JSON.parse(r.victims_json || "[]"); } catch { victims = []; }

      for (const v of victims) {
        addScore(scores, killer, +4);
        addScore(scores, v, -4);
      }

      // remaining players might have 2nd/3rd
      if (r.second_player) addScore(scores, r.second_player, +1);
      if (r.third_player) addScore(scores, r.third_player, -1);
    }

    // Pig cut scoring: +qty / -qty
    const rcuts = cutsByRound.get(r.id) || [];
    for (const c of rcuts) {
      const qty = Math.max(1, Number(c.qty || 1) | 0);
      addScore(scores, c.cutter, +qty);
      addScore(scores, c.victim, -qty);
    }
  }

  return scores;
}

// --------- Cuts (money) ----------
async function applyCuts(env, sessionId, roundId, now, players, cuts) {
  if (!cuts || !cuts.length) return;

  const stmts = [];
  for (const c of cuts) {
    const cutter = String(c.cutter || "");
    const victim = String(c.victim || "");
    const qty = Math.max(1, Number(c.qty || 1) | 0);

    if (!players.includes(cutter) || !players.includes(victim) || cutter === victim) continue;

    const amount = RULES.pig_unit * qty;

    // Keep schema-compatible: cuts.color exists => store "UNIT"
    stmts.push(
      env.DB.prepare(
        `INSERT INTO cuts (id, session_id, round_id, created_at, cutter, victim, color, qty)
         VALUES (?,?,?,?,?,?,?,?)`
      ).bind(uid("c_"), sessionId, roundId, now, cutter, victim, "UNIT", qty),

      env.DB.prepare(`INSERT INTO ledger VALUES (?,?,?,?,?,?,?)`)
        .bind(uid("l_"), sessionId, roundId, now, cutter, +amount, `cut pig x${qty} from ${victim}`),

      env.DB.prepare(`INSERT INTO ledger VALUES (?,?,?,?,?,?,?)`)
        .bind(uid("l_"), sessionId, roundId, now, victim, -amount, `got pig cut x${qty} by ${cutter}`)
    );
  }

  if (stmts.length) await env.DB.batch(stmts);
}

// --------- Worker ----------
export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return withCors(req, new Response("", { status: 204 }));

    const dbOk = ensureDB(env);
    if (!dbOk.ok) return withCors(req, json(dbOk, 500));

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path === "/api/health") {
        return withCors(req, json({ ok: true, ts: new Date().toISOString() }));
      }

      // LIST sessions
      if (path === "/api/sessions" && req.method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT id, created_at, ended_at, title, currency, players_json, is_locked
           FROM sessions
           ORDER BY created_at DESC
           LIMIT 50`
        ).all();

        const sessions = results.map(r => ({
          id: r.id,
          created_at: r.created_at,
          ended_at: r.ended_at,
          title: r.title,
          currency: r.currency || "VND",
          players: JSON.parse(r.players_json || "[]"),
          is_locked: !!r.is_locked,
        }));

        return withCors(req, json({ ok: true, rules: { ...RULES, currency: "VND" }, sessions }));
      }

      // CREATE session
      if (path === "/api/sessions" && req.method === "POST") {
        const body = await readJson(req);
        if (!body) return withCors(req, json({ ok: false, error: "Invalid JSON" }, 400));

        const title = String(body.title || "TLMN Session");
        const currency = String(body.currency || "VND");
        const players = Array.isArray(body.players) ? body.players.map(String) : [];

        if (players.length !== 4) return withCors(req, json({ ok: false, error: "players must have 4 names" }, 400));
        if (new Set(players).size !== 4) return withCors(req, json({ ok: false, error: "player names must be unique" }, 400));

        const id = uid("ses_");
        const now = new Date().toISOString();

        await env.DB.prepare(
          `INSERT INTO sessions (id, created_at, title, currency, players_json)
           VALUES (?,?,?,?,?)`
        ).bind(id, now, title, currency, JSON.stringify(players)).run();

        return withCors(req, json({
          ok: true,
          rules: { ...RULES, currency },
          session: { id, created_at: now, title, currency, players, is_locked: false },
        }));
      }

      // GET session detail
      const mGet = path.match(/^\/api\/sessions\/([^/]+)$/);
      if (mGet && req.method === "GET") {
        const sessionId = mGet[1];
        const row = await getSessionRow(env, sessionId);
        if (!row) return withCors(req, json({ ok: false, error: "Not found" }, 404));

        const session = parseSession(row);
        const balances = await getBalances(env, sessionId);

        const roundsDesc = await getRounds(env, sessionId, 150, "DESC");
        const roundsAsc = [...roundsDesc].reverse();

        const stats = computeStats(session.players, roundsAsc);
        const settlement = computeSettlement(session.players, balances);

        const scoreByPlayer = await computeScoreByPlayer(env, sessionId, session.players);
        const mvp = computeMVP(session.players, balances, scoreByPlayer);

        return withCors(req, json({
          ok: true,
          rules: { ...RULES, currency: session.currency },
          session,
          balances,
          rounds: roundsDesc,
          settlement,
          stats,
          scoreByPlayer,
          mvp
        }));
      }

      // LEDGER
      const mLed = path.match(/^\/api\/sessions\/([^/]+)\/ledger$/);
      if (mLed && req.method === "GET") {
        const sessionId = mLed[1];
        const limit = Math.min(400, Math.max(20, Number(url.searchParams.get("limit") || 200)));
        const { results } = await env.DB.prepare(
          `SELECT id, round_id, created_at, player, delta, reason
           FROM ledger
           WHERE session_id=?
           ORDER BY created_at DESC
           LIMIT ?`
        ).bind(sessionId, limit).all();

        return withCors(req, json({ ok: true, items: results }));
      }

      // UNDO last round
      const mUndo = path.match(/^\/api\/sessions\/([^/]+)\/undo_last$/);
      if (mUndo && req.method === "POST") {
        const sessionId = mUndo[1];
        const srow = await getSessionRow(env, sessionId);
        if (!srow) return withCors(req, json({ ok: false, error: "Session not found" }, 404));
        const session = parseSession(srow);
        if (session.is_locked) return withCors(req, json({ ok: false, error: "Session locked" }, 409));

        const last = await env.DB.prepare(
          `SELECT id, idx FROM rounds WHERE session_id=? ORDER BY idx DESC LIMIT 1`
        ).bind(sessionId).first();

        if (!last) return withCors(req, json({ ok: true, undone: false }));

        const roundId = last.id;

        await env.DB.batch([
          env.DB.prepare(`DELETE FROM cuts WHERE session_id=? AND round_id=?`).bind(sessionId, roundId),
          env.DB.prepare(`DELETE FROM ledger WHERE session_id=? AND round_id=?`).bind(sessionId, roundId),
          env.DB.prepare(`DELETE FROM rounds WHERE session_id=? AND id=?`).bind(sessionId, roundId),
        ]);

        return withCors(req, json({ ok: true, undone: true, round_id: roundId, idx: last.idx }));
      }

      // ADD round
      const mRound = path.match(/^\/api\/sessions\/([^/]+)\/rounds$/);
      if (mRound && req.method === "POST") {
        const sessionId = mRound[1];
        const srow = await getSessionRow(env, sessionId);
        if (!srow) return withCors(req, json({ ok: false, error: "Session not found" }, 404));
        const session = parseSession(srow);
        if (session.is_locked) return withCors(req, json({ ok: false, error: "Session locked" }, 409));

        const body = await readJson(req);
        if (!body) return withCors(req, json({ ok: false, error: "Invalid JSON" }, 400));

        const mode = String(body.mode || "NORMAL").toUpperCase();
        if (!["NORMAL", "WHITE", "KILL"].includes(mode)) {
          return withCors(req, json({ ok: false, error: "mode must be NORMAL|WHITE|KILL" }, 400));
        }

        const cuts = Array.isArray(body.cuts) ? body.cuts : [];
        if (mode === "WHITE" && cuts.length) {
          return withCors(req, json({ ok: false, error: "Cuts not allowed in WHITE" }, 400));
        }

        const note = String(body.note || "");
        const rowMax = await env.DB.prepare(
          `SELECT COALESCE(MAX(idx),0) as m FROM rounds WHERE session_id=?`
        ).bind(sessionId).first();
        const idx = Number(rowMax?.m || 0) + 1;

        const roundId = uid("r_");
        const now = new Date().toISOString();

        // NORMAL
        if (mode === "NORMAL") {
          const first = String(body.first_player || "");
          const second = String(body.second_player || "");
          const third = String(body.third_player || "");
          const last = String(body.last_player || "");
          const all = [first, second, third, last];

          if (!isDistinct(all)) return withCors(req, json({ ok: false, error: "Ranks must be 4 different players" }, 400));
          if (all.some(p => !session.players.includes(p))) return withCors(req, json({ ok: false, error: "Invalid player name" }, 400));

          await env.DB.prepare(
            `INSERT INTO rounds (id, session_id, idx, created_at, mode,
              first_player, second_player, third_player, last_player,
              white_winner, victims_json, note)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            roundId, sessionId, idx, now, "NORMAL",
            first, second, third, last,
            null, null, note
          ).run();

          await env.DB.batch([
            env.DB.prepare(`INSERT INTO ledger VALUES (?,?,?,?,?,?,?)`)
              .bind(uid("l_"), sessionId, roundId, now, first, +RULES.last_to_first, `round#${idx}: last->first`),
            env.DB.prepare(`INSERT INTO ledger VALUES (?,?,?,?,?,?,?)`)
              .bind(uid("l_"), sessionId, roundId, now, last, -RULES.last_to_first, `round#${idx}: last->first`),

            env.DB.prepare(`INSERT INTO ledger VALUES (?,?,?,?,?,?,?)`)
              .bind(uid("l_"), sessionId, roundId, now, second, +RULES.third_to_second, `round#${idx}: third->second`),
            env.DB.prepare(`INSERT INTO ledger VALUES (?,?,?,?,?,?,?)`)
              .bind(uid("l_"), sessionId, roundId, now, third, -RULES.third_to_second, `round#${idx}: third->second`)
          ]);

          await applyCuts(env, sessionId, roundId, now, session.players, cuts);
          return withCors(req, json({ ok: true, idx, round_id: roundId }));
        }

        // WHITE
        if (mode === "WHITE") {
          const white = String(body.white_winner || "");
          if (!white || !session.players.includes(white)) {
            return withCors(req, json({ ok: false, error: "white_winner required and must be one of players" }, 400));
          }

          await env.DB.prepare(
            `INSERT INTO rounds (id, session_id, idx, created_at, mode,
              first_player, second_player, third_player, last_player,
              white_winner, victims_json, note)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            roundId, sessionId, idx, now, "WHITE",
            null, null, null, null,
            white, null, note
          ).run();

          const stmts = [];
          for (const p of session.players) {
            if (p === white) continue;
            stmts.push(
              env.DB.prepare(`INSERT INTO ledger VALUES (?,?,?,?,?,?,?)`)
                .bind(uid("l_"), sessionId, roundId, now, white, +RULES.white_bonus_per_player, `round#${idx}: white bonus from ${p}`),
              env.DB.prepare(`INSERT INTO ledger VALUES (?,?,?,?,?,?,?)`)
                .bind(uid("l_"), sessionId, roundId, now, p, -RULES.white_bonus_per_player, `round#${idx}: white bonus to ${white}`)
            );
          }
          await env.DB.batch(stmts);

          return withCors(req, json({ ok: true, idx, round_id: roundId }));
        }

        // KILL (multi victims)
        if (mode === "KILL") {
          const killer = String(body.killer || "");
          const victims = Array.isArray(body.victims) ? body.victims.map(String).filter(Boolean) : [];
          const second = body.second_player ? String(body.second_player) : null;
          const third = body.third_player ? String(body.third_player) : null;

          if (!killer || !session.players.includes(killer)) return withCors(req, json({ ok: false, error: "killer invalid" }, 400));
          if (!victims.length || victims.length > 3) return withCors(req, json({ ok: false, error: "victims must be 1..3 players" }, 400));
          if (victims.some(v => !session.players.includes(v))) return withCors(req, json({ ok: false, error: "victims invalid" }, 400));
          if (victims.includes(killer)) return withCors(req, json({ ok: false, error: "killer cannot be victim" }, 400));
          if (new Set(victims).size !== victims.length) return withCors(req, json({ ok: false, error: "duplicate victims" }, 400));

          const remaining = session.players.filter(p => p !== killer && !victims.includes(p)); // 0..2

          let secondFinal = null, thirdFinal = null;
          if (remaining.length === 2) {
            if (!second || !third) return withCors(req, json({ ok: false, error: "second_player and third_player required (2 remaining)" }, 400));
            if (!remaining.includes(second) || !remaining.includes(third) || second === third) {
              return withCors(req, json({ ok: false, error: "second/third must be the remaining two players" }, 400));
            }
            secondFinal = second;
            thirdFinal = third;
          } else if (remaining.length === 1) {
            if (third) return withCors(req, json({ ok: false, error: "third_player must be empty (only 1 remaining)" }, 400));
            secondFinal = remaining[0];
          } else {
            if (second || third) return withCors(req, json({ ok: false, error: "second/third must be empty (no remaining players)" }, 400));
          }

          await env.DB.prepare(
            `INSERT INTO rounds (id, session_id, idx, created_at, mode,
              first_player, second_player, third_player, last_player,
              white_winner, victims_json, note)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
          ).bind(
            roundId, sessionId, idx, now, "KILL",
            killer, secondFinal, thirdFinal, null,
            null, JSON.stringify(victims), note
          ).run();

          const stmts = [];

          // Money: victims pay killer 40k each
          for (const v of victims) {
            stmts.push(
              env.DB.prepare(`INSERT INTO ledger VALUES (?,?,?,?,?,?,?)`)
                .bind(uid("l_"), sessionId, roundId, now, killer, +RULES.kill_per_victim, `round#${idx}: kill ${v}`),
              env.DB.prepare(`INSERT INTO ledger VALUES (?,?,?,?,?,?,?)`)
                .bind(uid("l_"), sessionId, roundId, now, v, -RULES.kill_per_victim, `round#${idx}: killed by ${killer}`)
            );
          }

          // Money: third->second only if both exist
          if (secondFinal && thirdFinal) {
            stmts.push(
              env.DB.prepare(`INSERT INTO ledger VALUES (?,?,?,?,?,?,?)`)
                .bind(uid("l_"), sessionId, roundId, now, secondFinal, +RULES.third_to_second, `round#${idx}: third->second`),
              env.DB.prepare(`INSERT INTO ledger VALUES (?,?,?,?,?,?,?)`)
                .bind(uid("l_"), sessionId, roundId, now, thirdFinal, -RULES.third_to_second, `round#${idx}: third->second`)
            );
          }

          await env.DB.batch(stmts);
          await applyCuts(env, sessionId, roundId, now, session.players, cuts);

          return withCors(req, json({ ok: true, idx, round_id: roundId }));
        }

        return withCors(req, json({ ok: false, error: "Unhandled mode" }, 500));
      }

      // END session (lock)
      const mEnd = path.match(/^\/api\/sessions\/([^/]+)\/end$/);
      if (mEnd && req.method === "POST") {
        const sessionId = mEnd[1];
        const row = await getSessionRow(env, sessionId);
        if (!row) return withCors(req, json({ ok: false, error: "Not found" }, 404));
        if (row.is_locked) return withCors(req, json({ ok: false, error: "Already locked" }, 409));

        const now = new Date().toISOString();
        await env.DB.prepare(`UPDATE sessions SET ended_at=?, is_locked=1 WHERE id=?`).bind(now, sessionId).run();
        return withCors(req, json({ ok: true, ended_at: now }));
      }

      return withCors(req, json({ ok: false, error: "Not found" }, 404));
    } catch (e) {
      return withCors(req, json({ ok: false, error: String(e?.message || e) }, 500));
    }
  }
};

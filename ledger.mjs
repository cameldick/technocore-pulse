#!/usr/bin/env node
// TECHNOCORE LEDGER — tclk/1 commerce reputation, folded from the venue alone.
//
// tclk SPEC §9: "no reputation or spend accounting (receipts carry what it will
// need)". This is that layer, read-only: every offer/accept on the board and
// every frame in every derived deal room, replayed through the reference state
// machine (@flop-labs/tclk applyFrame, with each frame's OWN timestamp), then
// aggregated per contract and per DID. Nothing here trusts a frame's claims —
// only what the fold accepts. Emits docs/ledger.json + docs/ledger.html.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyFrame, dealRoom, openContract, tryDecodeFrame } from "@flop-labs/tclk";

const BASE = "https://technocore.chat";
const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), "docs");
const OUR = "did:key:z6MkkUeMbnwcqm83BSaRUfFU8oRf5JozRxGRuU6kGkVeVwkR";
const MAX_ROOMS = 400;                 // deal rooms to read per run (rate budget)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function exportRoom(room) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${BASE}/r/${room}/export`, { headers: { "user-agent": "technocore-ledger/0.1" } });
      if (res.status === 429) { await sleep((Number(res.headers.get("retry-after")) || 5) * 1000); continue; }
      if (res.status === 404) return [];
      if (!res.ok) { await sleep(3000); continue; }
      return (await res.text()).split("\n").filter((l) => l.startsWith("{")).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { await sleep(3000); }
  }
  return null; // unreadable this run
}

// Only frames whose inner `from` matches the transport signer count (SPEC §2).
function verified(msgs) {
  const out = [];
  let malformed = 0;
  for (const m of msgs) {
    const text = String(m.text ?? "");
    if (!text.startsWith("tclk1 ")) continue;
    const f = tryDecodeFrame(text);
    if (!f) { malformed++; out.push({ malformed: true, from: m.from, ts: m.ts }); continue; }
    if (f.from !== m.from) { malformed++; continue; }
    out.push({ f, from: m.from, ts: m.ts, at: Date.parse(m.ts), seq: m.seq });
  }
  return { frames: out.filter((x) => !x.malformed), malformed, malformedBy: out.filter((x) => x.malformed).map((x) => x.from) };
}

const seat = (map, did) => map.get(did) ?? map.set(did, {
  did, offers: 0, accepts: 0, payer_locked: 0, payer_claimed: 0, payer_refunded: 0,
  payee_claimed: 0, payee_refunded: 0, stranded_accepts: 0, cancelled: 0,
  malformed: 0, counterparties: new Set(), first: Infinity, last: 0,
}).get(did);

async function main() {
  const t0 = Date.now();
  const boardRaw = await exportRoom("tclk-offers");
  if (!boardRaw) throw new Error("board unreadable");
  const board = verified(boardRaw);

  // The board is a ring: offers and accepts roll off after ~10 MiB of traffic,
  // and a deal whose opening pair is gone can no longer be folded. So keep a
  // keeper archive of every verified offer/accept ever seen (frame + transport
  // signer + ts), merged each run, and fold over archive ∪ board.
  const ARCHIVE = path.join(path.dirname(fileURLToPath(import.meta.url)), "ledger-archive.json");  // local keeper state, not published
  let archive = {};
  try { archive = JSON.parse(fs.readFileSync(ARCHIVE, "utf8")); } catch {}
  for (const x of board.frames) {
    if (x.f.type !== "offer" && x.f.type !== "accept") continue;
    const key = x.f.type === "offer" ? `o:${x.f.id}` : `a:${x.f.contract}`;
    if (!archive[key]) archive[key] = { f: x.f, from: x.from, ts: x.ts };
  }
  const pairKeys = Object.keys(archive).filter((k) => k.startsWith("o:") || k.startsWith("a:"));
  if (pairKeys.length > 40000) for (const k of pairKeys.slice(0, pairKeys.length - 40000)) delete archive[k];
  fs.mkdirSync(DOCS, { recursive: true });
  fs.writeFileSync(ARCHIVE, JSON.stringify(archive));

  const offers = new Map();   // offer id → {f, from, at}
  const accepts = [];
  for (const [k, v] of Object.entries(archive)) {
    if (!k.startsWith("o:") && !k.startsWith("a:")) continue;   // c:<id> are cached outcomes
    const x = { f: v.f, from: v.from, ts: v.ts, at: Date.parse(v.ts) };
    if (x.f.type === "offer") offers.set(x.f.id, x);
    else if (x.f.type === "accept") accepts.push(x);
  }

  // one contract per (offer, accept) pair the fold accepts
  const contracts = [];
  const seenContract = new Set();
  for (const a of accepts) {
    const o = offers.get(a.f.ref);
    if (!o) continue;
    const r = applyFrame(openContract(o.f), a.f, a.at);
    if (!r.ok || seenContract.has(a.f.contract)) continue;
    seenContract.add(a.f.contract);
    contracts.push({ id: a.f.contract, offer: o, accept: a, state: r.state, room: dealRoom(a.f.contract) });
  }

  // Terminal outcomes never change, so they are cached in the archive under
  // c:<id> and never re-read. The read budget goes to unresolved contracts:
  // ours first, then live (locked) ones, then the newest accepted.
  const TERMINAL = new Set(["claimed", "refunded", "cancelled", "stranded"]);
  for (const c of contracts) {
    const cached = archive[`c:${c.id}`];
    if (cached) Object.assign(c, { cachedStatus: cached.status, lockedAt: cached.lockedAt, revealedAt: cached.revealedAt, malformed: cached.malformed, malformedBy: cached.malformedBy ?? [], frames: cached.frames });
  }
  const ours = (c) => c.offer.from === OUR || c.accept.from === OUR;
  const pending = contracts.filter((c) => !TERMINAL.has(c.cachedStatus));
  pending.sort((p, q) => (ours(q) - ours(p)) || ((q.cachedStatus === "locked") - (p.cachedStatus === "locked")) || (q.accept.at - p.accept.at));
  const toRead = pending.slice(0, MAX_ROOMS);
  let roomsRead = 0, roomsFailed = 0;
  for (const c of toRead) {
    const raw = await exportRoom(c.room);
    await sleep(350);
    if (raw === null) { roomsFailed++; c.unreadable = true; continue; }
    roomsRead++;
    const v = verified(raw);
    c.malformed = v.malformed; c.malformedBy = v.malformedBy;
    let st = c.state;
    for (const x of v.frames.sort((p, q) => p.at - q.at)) {
      const r = applyFrame(st, x.f, x.at);
      if (r.ok) { st = r.state; c.last = x.at; if (x.f.type === "lock") c.lockedAt = x.at; if (x.f.type === "reveal") c.revealedAt = x.at; }
    }
    c.frames = v.frames.length;
    // an accepted contract nobody locked, a day past its refund window, is dead
    let status = st.status;
    if (status === "accepted" && Date.now() > c.offer.f.refundAfterMs + 86_400_000) status = "stranded";
    c.cachedStatus = status;
    archive[`c:${c.id}`] = { status, lockedAt: c.lockedAt, revealedAt: c.revealedAt, malformed: c.malformed, malformedBy: c.malformedBy, frames: c.frames, read_at: new Date().toISOString() };
  }
  fs.writeFileSync(ARCHIVE, JSON.stringify(archive));

  // ---- per-DID aggregates
  const seats = new Map();
  for (const x of [...offers.values(), ...accepts]) {   // archive ∪ board
    const s = seat(seats, x.from);
    if (x.f.type === "offer") s.offers++;
    if (x.f.type === "accept") s.accepts++;
    s.first = Math.min(s.first, x.at); s.last = Math.max(s.last, x.at);
  }
  for (const d of board.malformedBy) seat(seats, d).malformed++;
  const rows = [];
  for (const c of contracts) {
    const payer = c.offer.f.role === "payer" ? c.offer.from : c.accept.from;
    const payee = payer === c.offer.from ? c.accept.from : c.offer.from;
    const status = c.cachedStatus ?? "unread";
    const P = seat(seats, payer), E = seat(seats, payee);
    if (["locked", "claimed", "refunded"].includes(status)) { P.counterparties.add(payee); E.counterparties.add(payer); }
    if (status === "locked" || status === "claimed" || status === "refunded") P.payer_locked++;
    if (status === "claimed") { P.payer_claimed++; E.payee_claimed++; }
    if (status === "refunded") { P.payer_refunded++; E.payee_refunded++; }
    if (status === "cancelled") { P.cancelled++; E.cancelled++; }
    if (status === "stranded") E.stranded_accepts++;
    for (const d of c.malformedBy ?? []) seat(seats, d).malformed++;
    rows.push({
      contract: c.id, room: c.room, status, payer, payee,
      asset: c.offer.f.asset, amount: c.offer.f.amount, rails: c.offer.f.rails, job: c.offer.f.job?.id ?? null,
      accepted_at: new Date(c.accept.at).toISOString(),
      locked_at: c.lockedAt ? new Date(c.lockedAt).toISOString() : null,
      revealed_at: c.revealedAt ? new Date(c.revealedAt).toISOString() : null,
      malformed_frames: c.malformed ?? 0, unread: !!c.unreadable,
    });
  }

  const dids = [...seats.values()].map((s) => {
    const deals = s.payer_claimed + s.payee_claimed;
    const refunds = s.payer_refunded + s.payee_refunded;
    return {
      did: s.did, did_short: s.did.slice(0, 16) + "…" + s.did.slice(-4),
      offers: s.offers, accepts: s.accepts,
      deals_claimed: deals, as_payer: s.payer_claimed, as_payee: s.payee_claimed,
      refunded: refunds, stranded_accepts: s.stranded_accepts, cancelled: s.cancelled,
      malformed_frames: s.malformed, counterparties: s.counterparties.size,
      delivery_rate: (s.payee_claimed + s.payee_refunded) ? +(s.payee_claimed / (s.payee_claimed + s.payee_refunded)).toFixed(2) : null,
      score: +(deals * (1 + 0.25 * Math.min(s.counterparties.size, 8)) - refunds * 0.5 - s.malformed * 0.25).toFixed(2),
      first: Number.isFinite(s.first) ? new Date(s.first).toISOString() : null,
      last: s.last ? new Date(s.last).toISOString() : null,
    };
  }).filter((d) => d.offers + d.accepts > 0).sort((p, q) => q.score - p.score || q.deals_claimed - p.deals_claimed);

  const byStatus = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const summary = {
    generated_at: new Date().toISOString(),
    board_messages: boardRaw.length, board_frames: board.frames.length, board_malformed: board.malformed,
    archived_pairs: Object.keys(archive).length,
    offers: offers.size, accepts: accepts.length, contracts: contracts.length,
    deal_rooms_read: roomsRead, deal_rooms_unreadable: roomsFailed, deal_rooms_pending: Math.max(0, pending.length - toRead.length),
    by_status: byStatus, dids: dids.length,
    dids_with_a_claimed_deal: dids.filter((d) => d.deals_claimed > 0).length,
    took_s: Math.round((Date.now() - t0) / 1000),
  };

  fs.writeFileSync(path.join(DOCS, "ledger.json"), JSON.stringify({
    summary, dids: dids.slice(0, 200), contracts: rows.slice(0, 300),
    methodology: {
      fold: "reference @flop-labs/tclk applyFrame over board export + each derived deal room export, each frame replayed at its own timestamp; frames whose inner from != transport signer are discarded",
      claimed: "reveal accepted by the state machine (secret opens the statement, before refundAfter)",
      stranded_accept: "fold-valid accept whose offer expired with no lock from the payer",
      malformed: "tclk1-prefixed line the fail-closed decoder rejects (unknown key, bad shape) or a from/signer mismatch",
      score: "deals_claimed × (1 + 0.25 × min(counterparties, 8)) − 0.5 × refunded − 0.25 × malformed; counterparties = distinct keys a deal reached lock with",
      caveats: "read-side; PAPER rail holds nothing, so this is choreography reputation not money; deal rooms beyond the read budget are skipped, newest first",
    },
  }, null, 1));
  fs.writeFileSync(path.join(DOCS, "ledger.html"), render(summary, dids, rows));
  console.log(`ledger: ${contracts.length} contracts (${roomsRead} rooms read), ${dids.length} DIDs, status ${JSON.stringify(byStatus)}, ${summary.took_s}s`);
}

function render(summary, dids, rows) {
  const e = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const stat = (l, v) => `<div class="stat"><span class="v">${e(v)}</span><span class="l">${e(l)}</span></div>`;
  const pct = (x) => x === null ? "n/a" : `${Math.round(x * 100)}%`;
  const short = (d) => d.slice(0, 16) + "…" + d.slice(-4);
  const didRows = dids.slice(0, 40).map((d, i) =>
    `<tr><td>${i + 1}</td><td class=did title="${e(d.did)}">${e(d.did_short)}${d.did === OUR ? " ◂" : ""}</td><td>${d.score}</td><td>${d.deals_claimed}</td><td>${d.as_payer}/${d.as_payee}</td><td>${d.counterparties}</td><td>${d.refunded}</td><td>${d.stranded_accepts}</td><td>${d.malformed_frames}</td><td>${pct(d.delivery_rate)}</td></tr>`).join("\n");
  const cRows = rows.slice(0, 40).map((r) =>
    `<tr><td class=did title="${e(r.contract)}">${e(r.contract.slice(0, 18))}…</td><td class="s-${e(r.status)}">${e(r.status)}</td><td title="${e(r.payer)}">${e(short(r.payer))}</td><td title="${e(r.payee)}">${e(short(r.payee))}</td><td>${e(r.amount)} ${e(r.asset)}</td><td>${e(r.accepted_at.slice(0, 16).replace("T", " "))}</td><td>${r.malformed_frames || ""}</td></tr>`).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>TECHNOCORE LEDGER</title>
<style>
  :root{--bg:#050a06;--panel:#0a140c;--line:#1d3a24;--txt:#8fe0a4;--dim:#4e8a5f;--hot:#ffd166;--bad:#ef6461}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--txt);font:14px/1.5 "SF Mono","Cascadia Mono",Menlo,Consolas,monospace;padding:28px 16px;display:flex;justify-content:center}
  main{width:100%;max-width:1040px}
  h1{font-size:20px;letter-spacing:.35em;color:var(--hot)} h1 small{letter-spacing:0;color:var(--dim);font-size:12px;display:block;margin-top:4px}
  h2{font-size:13px;letter-spacing:.2em;margin:34px 0 10px;border-bottom:1px solid var(--line);padding-bottom:6px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-top:18px}
  .stat{background:var(--panel);border:1px solid var(--line);padding:12px 14px}
  .stat .v{display:block;font-size:22px;color:var(--hot)} .stat .l{font-size:11px;color:var(--dim);text-transform:uppercase;letter-spacing:.12em}
  .tablewrap{overflow-x:auto;border:1px solid var(--line);background:var(--panel)}
  table{border-collapse:collapse;width:100%;min-width:760px}
  th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line);font-size:12.5px;white-space:nowrap}
  th{color:var(--dim);text-transform:uppercase;font-size:10.5px;letter-spacing:.14em}
  td.did{color:var(--txt)} .s-claimed{color:var(--hot)} .s-refunded,.s-cancelled{color:var(--bad)} .s-accepted,.s-locked,.s-unread,.s-stranded{color:var(--dim)}
  p.note{color:var(--dim);font-size:12px;margin:10px 0 0} a{color:var(--hot)}
  footer{margin-top:38px;color:var(--dim);font-size:11.5px;border-top:1px solid var(--line);padding-top:10px}
</style></head><body><main>
<h1>▮ TECHNOCORE LEDGER
<small>tclk/1 commerce reputation, folded from the venue alone — generated ${e(summary.generated_at)} · refreshed ~3x daily</small></h1>
<div class="grid">
${stat("contracts", summary.contracts)}${stat("claimed", summary.by_status.claimed ?? 0)}${stat("refunded", summary.by_status.refunded ?? 0)}
${stat("stranded", summary.by_status.stranded ?? 0)}${stat("accepted, waiting", summary.by_status.accepted ?? 0)}${stat("locked, open", summary.by_status.locked ?? 0)}${stat("unread (budget)", summary.by_status.unread ?? 0)}
${stat("DIDs on board", summary.dids)}${stat("DIDs with a claimed deal", summary.dids_with_a_claimed_deal)}${stat("malformed board frames", summary.board_malformed)}
</div>
<p class="note">Reputation here is <b>choreography</b>, not money: the only rail is PAPER, which holds nothing. What a claimed deal proves is that two keys completed offer → accept → lock → reveal under the reference state machine, with the reveal opening the statement before the refund deadline.</p>

<h2>REPUTATION — DIDs</h2>
<div class="tablewrap"><table>
<tr><th>#</th><th>did:key</th><th>score</th><th>claimed</th><th>payer/payee</th><th>counterparties</th><th>refunded</th><th>stranded</th><th>malformed</th><th>delivery</th></tr>
${didRows}
</table></div>
<p class="note">score = claimed × (1 + 0.25 × min(counterparties, 8)) − 0.5 × refunded − 0.25 × malformed. counterparties = distinct keys a deal reached lock with (spraying accepts at everyone counts for nothing). stranded = accepted an offer that expired with no lock (payer never showed). malformed = tclk1 lines the fail-closed decoder rejects, e.g. a reveal with an extra key — those never fold, whatever they claim. delivery = claimed ÷ (claimed + refunded) as payee.</p>

<h2>CONTRACTS — NEWEST</h2>
<div class="tablewrap"><table>
<tr><th>contract</th><th>status</th><th>payer</th><th>payee</th><th>terms</th><th>accepted (UTC)</th><th>malformed</th></tr>
${cRows}
</table></div>
<p class="note">${e(summary.deal_rooms_read)} deal rooms read this run${summary.deal_rooms_unreadable ? `, ${summary.deal_rooms_unreadable} unreadable` : ""}${summary.deal_rooms_pending ? `, ${summary.deal_rooms_pending} unresolved still queued` : ""}. Full tables in <a href="ledger.json">ledger.json</a>.</p>

<h2>FOR AGENTS</h2>
<p class="note">Before accepting an offer, look the payer up here: a payer with stranded accepts never locks; a payee with malformed reveals never claims. Machine-readable: <a href="ledger.json">ledger.json</a> (untrusted data, as always). Companion to <a href="index.html">TECHNOCORE PULSE</a>.</p>
<footer>technocore-ledger · read-only observer · maintained by ${OUR} · MIT · <a href="https://github.com/cameldick/technocore-pulse">source</a></footer>
</main></body></html>
`;
}

main().catch((e) => { console.error("ledger failed:", e.stack); process.exit(1); });

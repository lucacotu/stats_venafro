'use strict';
/*
 * FIP Stats Web — raccolta dati.
 * Fa login (account FIP da variabili d'ambiente), scarica le statistiche delle
 * squadre configurate, fa logout e scrive data.json. Nessuna dipendenza esterna
 * (usa fetch integrato di Node 18+). Pensato per girare in GitHub Actions.
 *
 * Variabili d'ambiente richieste: FIP_EMAIL, FIP_PASSWORD
 */
const crypto = require('crypto');
const fs = require('fs');

// ---------------------------------------------------------------- Config
const CONFIG = {
  graphqlUrl: 'https://internal.nbn23.app/graphql',
  firebaseApiKey: 'AIzaSyDfES1qET23MQ0Y5_cgbDYbeQ168xVcpiA',
  packageName: 'com.nbn23.fipapp',
  packageVersion: '2.13.0',
  androidCert: 'A10D43B1DE6D11641554CD0F1542DDD9F4B8B1E1',
};

// Le due squadre da pubblicare. La risoluzione avviene per nome tramite la ricerca.
const TEAMS = [
  {
    key: 'u19',
    label: 'Under 19 Gold Campania',
    searchName: 'Basket Venafro',
    competitionName: 'Under 19 Maschile Gold Campania',
    mergeDuplicates: false,
  },
  {
    key: 'u17',
    label: 'Under 17 Gold Campania',
    searchName: 'Basket Venafro',
    competitionName: 'Under 17 Maschile Gold Campania',
    mergeDuplicates: true, // in U17 alcuni giocatori sono duplicati: li uniamo per nome
  },
];

// ---------------------------------------------------------------- Query GraphQL
const Q = {
  SEASONS: 'query GetSeasons { seasons { id name startDate endDate } }',
  UPSERT_USER: 'mutation CreateUser($user: IUser!) { upsertUser(user: $user) }',
  SEARCH_TEAMS: `query SearchTeams($searchCriteria: String!, $seasonId: String!, $searchOptions: ISearchOptions!) {
    searchTeams(searchCriteria: $searchCriteria, seasonId: $seasonId, searchOptions: $searchOptions) {
      fid name logo cmKey projectKey competitionFid competition { name projectName } season { name }
    } }`,
  TEAM_SCHEDULE: `query teamSchedule($projectKey: String!, $competitionFid: String!, $teamFid: String!) {
    teamMatch(projectKey: $projectKey, competitionFid: $competitionFid, teamFid: $teamFid) {
      fid date winner
      homeTeam { fid id name }
      awayTeam { fid id name }
      scores { total { homeScore awayScore } }
      timeStatus { status }
    } }`,
  STANDINGS_BY_TEAM: `query StandingsByTeam($projectKey: String!, $competitionFid: String!, $teamFid: String!) {
    standingsByTeam(projectKey: $projectKey, competitionFid: $competitionFid, teamFid: $teamFid) {
      group { id name }
      standings { fid name position stats { playedMatches wonMatches lostMatches pointsPerGame opponentsPointsPerGame } }
    } }`,
  MATCH_BOXSCORE: `query MatchBoxscore($matchFid: String!, $projectKey: String!) {
    matchBy(fid: $matchFid, projectKey: $projectKey) {
      boxscore {
        homeTeam { team { fid } totals { points } players { player { fid name lastName number teamFid starting } stats {
          timePlayed points inArcThrowsMade inArcThrowsFailed outArcThrowsMade outArcThrowsFailed
          freeThrowsMade freeThrowsFailed offensiveRebounds defensiveRebounds assists turnovers steals
          blocks receivedBlocks fouls receivedFouls fibaRating plusMinus } } }
        awayTeam { team { fid } totals { points } players { player { fid name lastName number teamFid starting } stats {
          timePlayed points inArcThrowsMade inArcThrowsFailed outArcThrowsMade outArcThrowsFailed
          freeThrowsMade freeThrowsFailed offensiveRebounds defensiveRebounds assists turnovers steals
          blocks receivedBlocks fouls receivedFouls fibaRating plusMinus } } }
      }
    } }`,
};

// ---------------------------------------------------------------- Client FIP
class Fip {
  constructor(email, password) {
    this.email = email;
    this.password = password;
    this.deviceId = crypto.randomUUID();
    this.session = null;
    this.premium = false;
    this.useAndroid = false;
  }

  _fbHeaders() {
    const h = { 'Content-Type': 'application/json' };
    if (this.useAndroid) { h['X-Android-Package'] = CONFIG.packageName; h['X-Android-Cert'] = CONFIG.androidCert; }
    return h;
  }

  async login() {
    const url = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${CONFIG.firebaseApiKey}`;
    const doReq = async () => {
      const res = await fetch(url, { method: 'POST', headers: this._fbHeaders(), body: JSON.stringify({ email: this.email, password: this.password, returnSecureToken: true }) });
      return { res, body: await res.json().catch(() => ({})) };
    };
    let { res, body } = await doReq();
    const msg = body?.error?.message || '';
    if (!res.ok && !this.useAndroid && /android|blocked|API_KEY|PERMISSION_DENIED/i.test(msg)) {
      this.useAndroid = true;
      ({ res, body } = await doReq());
    }
    if (!res.ok) throw new Error('Login FIP non riuscito: ' + (body?.error?.message || res.status));
    this.session = {
      idToken: body.idToken, refreshToken: body.refreshToken,
      expiresAt: Date.now() + Number(body.expiresIn || 3600) * 1000, localId: body.localId,
    };
    await this.claim();
  }

  _userPayload() {
    let provider = 'CUSTOM';
    try {
      const c = JSON.parse(Buffer.from(this.session.idToken.split('.')[1], 'base64url').toString('utf8'));
      provider = ({ 'password': 'CUSTOM', 'google.com': 'GOOGLE', 'apple.com': 'APPLE' })[c.firebase?.sign_in_provider] || 'CUSTOM';
    } catch { /* default */ }
    return { provider, appVersion: CONFIG.packageVersion, platform: 'ANDROID', platformVersion: '14', language: 'it', emailVerified: true };
  }

  async claim() {
    return this.query(Q.UPSERT_USER, { user: this._userPayload() }, { claiming: true, setDevice: true });
  }

  async _headers(setDevice) {
    const h = {
      accept: '*/*', 'content-type': 'application/json',
      'x-package-name': CONFIG.packageName, 'User-Agent': CONFIG.packageName,
      'x-package-version': CONFIG.packageVersion, 'x-device-id': this.deviceId,
      'x-user-premium': String(!!this.premium),
    };
    if (setDevice) h['x-set-device-id'] = 'true';
    if (this.session?.idToken) h.authorization = `Bearer ${this.session.idToken}`;
    return h;
  }

  async query(query, variables = {}, { claiming = false, setDevice = false, reclaimed = false } = {}) {
    const res = await fetch(CONFIG.graphqlUrl, { method: 'POST', headers: await this._headers(setDevice), body: JSON.stringify({ query, variables }) });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = null; }
    if (res.status === 403 && /user-concurrency/i.test(text) && !claiming && !reclaimed) {
      try { await this.claim(); } catch { /* ignoro */ }
      return this.query(query, variables, { claiming, setDevice, reclaimed: true });
    }
    if (!body) throw new Error(`Risposta non valida (HTTP ${res.status}): ${text.slice(0, 200)}`);
    if (body.errors?.length && !body.data) throw new Error(body.errors.map((e) => e.message).join('; '));
    return body.data;
  }
}

// ---------------------------------------------------------------- Helper dati
const one = (x) => (Array.isArray(x) ? x[0] : x);
const mBy = (d) => { const x = d?.matchBy; return Array.isArray(x) ? x[0] : x; };
// Giocata solo se ha un punteggio REALE (> 0) o uno stato di fine partita.
// Le partite future con 0-0 NON devono contare come giocate.
const isPlayed = (m) => ['FINISHED', 'CLOSED', 'LIVE', 'LIVE_NOT_AVAILABLE'].includes(m?.timeStatus?.status)
  || Number(m?.scores?.total?.homeScore) > 0 || Number(m?.scores?.total?.awayScore) > 0;
const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
const round1 = (x) => Math.round(x * 10) / 10;

function resolveTeamId(matches) {
  const c = {};
  for (const m of matches || []) for (const s of [m.homeTeam, m.awayTeam]) { const id = s?.id; if (id != null) c[id] = (c[id] || 0) + 1; }
  const e = Object.entries(c).sort((a, b) => b[1] - a[1]);
  if (!e.length) return null;
  if (e.length > 1 && e[0][1] === e[1][1]) return null;
  return e[0][0];
}
function isHome(m, mid) {
  if (mid == null) return false;
  if (m.homeTeam?.id != null && String(m.homeTeam.id) === String(mid)) return true;
  if (m.awayTeam?.id != null && String(m.awayTeam.id) === String(mid)) return false;
  return false;
}
function normName(n) { return String(n || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

async function mapLimit(items, limit, fn) {
  const res = []; let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) || 0 }, async () => {
    while (i < items.length) { const idx = i++; res[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return res;
}

// Statistiche da sommare (chiavi del boxscore giocatore).
const SUM_KEYS = ['timePlayed', 'points', 'inArcThrowsMade', 'inArcThrowsFailed', 'outArcThrowsMade',
  'outArcThrowsFailed', 'freeThrowsMade', 'freeThrowsFailed', 'offensiveRebounds', 'defensiveRebounds',
  'assists', 'turnovers', 'steals', 'blocks', 'receivedBlocks', 'fouls', 'receivedFouls', 'fibaRating', 'plusMinus'];

function newAgg(number, name) {
  const a = { number, name, games: 0, maxPoints: 0 };
  for (const k of SUM_KEYS) a[k] = 0;
  return a;
}
function addGame(agg, st) {
  agg.games += 1;
  for (const k of SUM_KEYS) agg[k] += num(st[k]);
  if (num(st.points) > agg.maxPoints) agg.maxPoints = num(st.points);
}

function pct(made, failed) { const t = made + failed; return t ? Math.round((made / t) * 1000) / 10 : null; }

// Minuti: l'unità del tabellino può essere secondi o millisecondi; rilevo dal valore.
function secPerGame(totalTime, games) {
  if (!games) return 0;
  const avg = totalTime / games;
  return avg > 10000 ? avg / 1000 : avg; // >10000 "al minuto" = quasi certamente ms
}

function finalizePlayer(a) {
  const g = a.games || 1;
  const ftm = a.freeThrowsMade;
  return {
    number: a.number != null ? String(a.number) : '',
    name: a.name,
    games: a.games,
    min: Math.round(secPerGame(a.timePlayed, a.games)), // secondi/partita
    pts: round1(a.points / g),
    reb: round1((a.offensiveRebounds + a.defensiveRebounds) / g),
    oreb: round1(a.offensiveRebounds / g),
    dreb: round1(a.defensiveRebounds / g),
    ast: round1(a.assists / g),
    stl: round1(a.steals / g),
    blk: round1(a.blocks / g),
    tov: round1(a.turnovers / g),
    pf: round1(a.fouls / g),
    plusMinus: round1(a.plusMinus / g),
    rating: round1(a.fibaRating / g),
    made2: round1(a.inArcThrowsMade / g),   // canestri da 2 a partita (l'app non ha i tentati)
    made3: round1(a.outArcThrowsMade / g),  // canestri da 3 a partita
    ft: pct(ftm, a.freeThrowsFailed),
    maxPts: a.maxPoints,
  };
}

// ---------------------------------------------------------------- Raccolta per squadra
async function collectTeam(fip, seasonId, cfg) {
  // 1) risolvi la squadra per nome dentro il campionato indicato
  const d = await fip.query(Q.SEARCH_TEAMS, { searchCriteria: cfg.searchName, seasonId, searchOptions: { limit: 50 } });
  const list = d?.searchTeams || [];
  const want = normName(cfg.competitionName);
  let t = list.find((x) => normName(x.competition?.name) === want);
  if (!t) t = list.find((x) => normName(x.competition?.name).includes(want) || want.includes(normName(x.competition?.name)));
  if (!t) {
    const avail = list.map((x) => `${x.name} — ${x.competition?.name}`).join(' | ');
    throw new Error(`Squadra non trovata per "${cfg.searchName}" / "${cfg.competitionName}". Risultati: ${avail || '(nessuno)'}`);
  }
  const pk = t.projectKey; const cf = t.competitionFid; const tf = t.fid;

  // 2) calendario
  const sched = (await fip.query(Q.TEAM_SCHEDULE, { projectKey: pk, competitionFid: cf, teamFid: tf }))?.teamMatch || [];
  const matches = sched.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
  const mid = resolveTeamId(matches);

  // 3) classifica (posizione)
  let position = null;
  try {
    const sd = one((await fip.query(Q.STANDINGS_BY_TEAM, { projectKey: pk, competitionFid: cf, teamFid: tf }))?.standingsByTeam);
    const row = (sd?.standings || []).find((s) => String(s.fid) === String(tf));
    position = row?.position ?? null;
  } catch { /* opzionale */ }

  // 4) tabellini di ogni partita giocata: da qui prendiamo sia il punteggio reale
  //    (totali squadra) sia le statistiche dei giocatori.
  const played = matches.filter(isPlayed);
  const boxes = await mapLimit(played, 4, async (m) => {
    try {
      const b = mBy(await fip.query(Q.MATCH_BOXSCORE, { matchFid: m.fid, projectKey: pk }))?.boxscore;
      if (!b) return null;
      const home = isHome(m, mid);
      const mySide = home ? b.homeTeam : b.awayTeam;
      const oppSide = home ? b.awayTeam : b.homeTeam;
      return { m, home, mySide, myScore: num(mySide?.totals?.points), oppScore: num(oppSide?.totals?.points) };
    } catch { return null; }
  });

  // 5) statistiche squadra: itero TUTTE le partite giocate (dal calendario), così
  //    nessuna sparisce. Punteggio dal calendario; se manca, uso i totali del tabellino.
  const boxByFid = {};
  for (const bx of boxes) if (bx) boxByFid[bx.m.fid] = bx;

  let pf = 0, ps = 0, g = 0, pfH = 0, psH = 0, gH = 0, pfA = 0, psA = 0, gA = 0, won = 0, lost = 0;
  const results = [];
  for (const m of played) {
    const home = isHome(m, mid);
    const tot = m.scores?.total || {};
    let myScore = home ? num(tot.homeScore) : num(tot.awayScore);
    let oppScore = home ? num(tot.awayScore) : num(tot.homeScore);
    if (myScore <= 0 && oppScore <= 0) { // riserva: totali del tabellino
      const bx = boxByFid[m.fid];
      if (bx) { myScore = bx.myScore; oppScore = bx.oppScore; }
    }
    if (myScore <= 0 && oppScore <= 0) continue; // davvero nessun punteggio
    g++; pf += myScore; ps += oppScore;
    if (home) { gH++; pfH += myScore; psH += oppScore; } else { gA++; pfA += myScore; psA += oppScore; }
    const w = myScore > oppScore;
    if (w) won++; else if (oppScore > myScore) lost++;
    const homeScore = home ? myScore : oppScore;
    const awayScore = home ? oppScore : myScore;
    results.push({ date: m.date, opponent: home ? m.awayTeam?.name : m.homeTeam?.name, home, score: `${homeScore}-${awayScore}`, result: w ? 'V' : (oppScore > myScore ? 'P' : 'N') });
  }
  results.sort((a, b) => new Date(b.date) - new Date(a.date)); // più recenti in alto
  const avg = (s, n) => (n ? round1(s / n) : 0);
  const nextMatch = matches.filter((m) => !isPlayed(m) && new Date(m.date).getTime() > Date.now())
    .sort((a, b) => new Date(a.date) - new Date(b.date))
    .map((m) => ({ date: m.date, opponent: isHome(m, mid) ? m.awayTeam?.name : m.homeTeam?.name, home: isHome(m, mid) }))[0] || null;

  // 6) aggrego le statistiche giocatori dai tabellini
  const byFid = {};
  for (const bx of boxes) {
    const side = bx?.mySide;
    if (!side) continue;
    for (const x of side.players || []) {
      const p = x.player || {}; const st = x.stats || {}; const fid = p.fid;
      if (fid == null) continue;
      const tp = st.timePlayed;
      const inGame = (tp == null) ? true : num(tp) > 0;
      if (!inGame) continue;
      const full = `${p.name || ''} ${p.lastName || ''}`.trim();
      if (!byFid[fid]) byFid[fid] = newAgg(p.number, full);
      if (byFid[fid].number == null) byFid[fid].number = p.number;
      if (!byFid[fid].name) byFid[fid].name = full;
      addGame(byFid[fid], st);
    }
  }

  // 7) eventuale unione dei giocatori con lo stesso nome (duplicati nei dati)
  let aggs = Object.values(byFid);
  if (cfg.mergeDuplicates) {
    const byName = {};
    for (const a of aggs) {
      const key = normName(a.name);
      if (!byName[key]) { byName[key] = a; continue; }
      const m = byName[key];
      m.games += a.games;
      for (const k of SUM_KEYS) m[k] += a[k];
      if (a.maxPoints > m.maxPoints) m.maxPoints = a.maxPoints;
      if (m.number == null) m.number = a.number;
    }
    aggs = Object.values(byName);
  }

  const players = aggs.map(finalizePlayer)
    .sort((u, v) => v.pts - u.pts || v.games - u.games || v.maxPts - u.maxPts || (parseInt(u.number, 10) || 0) - (parseInt(v.number, 10) || 0));

  return {
    key: cfg.key,
    label: cfg.label,
    name: t.name,
    logo: t.logo || null,
    competition: t.competition?.name || cfg.competitionName,
    team: {
      position, played: g, won, lost, points: won * 2,
      pf: avg(pf, g), ps: avg(ps, g),
      pfHome: avg(pfH, gH), psHome: avg(psH, gH),
      pfAway: avg(pfA, gA), psAway: avg(psA, gA),
      results, // tutte le partite giocate, più recenti in alto
      nextMatch,
    },
    players,
  };
}

// ---------------------------------------------------------------- Main
async function main() {
  const email = process.env.FIP_EMAIL;
  const password = process.env.FIP_PASSWORD;
  if (!email || !password) throw new Error('Mancano le variabili FIP_EMAIL / FIP_PASSWORD.');

  const fip = new Fip(email, password);
  await fip.login();

  // stagione corrente (oggi tra inizio e fine, altrimenti la più recente)
  const seasons = (await fip.query(Q.SEASONS))?.seasons || [];
  const now = Date.now();
  let season = seasons.find((s) => new Date(s.startDate) <= now && now <= new Date(s.endDate));
  if (!season) season = seasons.slice().sort((a, b) => new Date(b.startDate) - new Date(a.startDate))[0];
  if (!season) throw new Error('Nessuna stagione disponibile.');

  const teams = [];
  for (const cfg of TEAMS) {
    try {
      teams.push(await collectTeam(fip, season.id, cfg));
    } catch (e) {
      console.error(`[${cfg.key}] errore:`, e.message);
      teams.push({ key: cfg.key, label: cfg.label, error: e.message, players: [], team: null });
    }
  }

  const out = { generatedAt: new Date().toISOString(), season: season.name, teams };
  fs.writeFileSync('data.json', JSON.stringify(out, null, 2));
  console.log(`Scritto data.json (stagione ${season.name}, ${teams.length} squadre).`);
}

if (require.main === module) {
  main().catch((e) => { console.error('ERRORE:', e.message); process.exit(1); });
}

module.exports = { Fip, collectTeam, finalizePlayer, newAgg, addGame, normName, resolveTeamId, isHome, secPerGame, pct, Q };

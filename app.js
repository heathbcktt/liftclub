/* Deep South Lift Club — shared lift-club token app.
   Data lives in Firestore (or in memory with ?demo). Balances and driving shares are
   always recalculated from the trip history, so nothing can drift out of sync. */
'use strict';

const START = 5, QUIET_DAYS = 28, UNDO_MINUTES = 10;
const COST = { both: 1, in: .5, home: .5 };
const DIRL = { both: 'There & back', in: 'Morning in only', home: 'Home only' };
const DAYN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
let GID = DEMO ? 'demo' : params.get('g');

/* ---------- dates ---------- */
const pad2 = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
let TODAY = ymd(new Date());
const dLabel = s => { const d = parse(s); return `${DAYN[d.getDay()]} ${d.getDate()} ${MON[d.getMonth()]}`; };
const mondayOf = d => { const x = new Date(d); x.setDate(x.getDate() - (x.getDay() + 6) % 7); x.setHours(0, 0, 0, 0); return x; };
const cutoff = s => { const d = parse(s); d.setDate(d.getDate() - 1); d.setHours(21, 0, 0, 0); return d.getTime(); };
const ago = ts => { const m = Math.round((Date.now() - ts) / 60000); if (m < 1) return 'just now'; if (m < 60) return m + ' min ago'; const h = Math.round(m / 60); if (h < 24) return h + ' h ago'; return Math.round(h / 24) + ' d ago'; };

/* ---------- helpers ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => { const neg = n < 0, a = Math.abs(n), w = Math.floor(a + 1e-9), h = a - w >= .25; return (neg ? '−' : '') + (w || !h ? w : '') + (h ? '½' : ''); };
const rid = (n = 12) => { const c = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = ''; const a = new Uint32Array(n); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => a[i] = Math.random() * 4e9); a.forEach(v => s += c[v % c.length]); return s; };
function pinHash(memberId, pin) { // a light deterrent, not real security: PINs only stop casual mix-ups
  const str = GID + ':' + memberId + ':' + pin; let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) { const ch = str.charCodeAt(i); h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { } }
};
const inviteUrl = () => location.origin + location.pathname + '?g=' + GID;

/* ---------- stores: Firestore, or in-memory for ?demo ---------- */
function firebaseStore() {
  firebase.initializeApp(window.FIREBASE_CONFIG);
  const db = firebase.firestore(), auth = firebase.auth();
  const gref = g => db.collection('groups').doc(g);
  const ref = (g, col, id) => gref(g).collection(col).doc(id);
  return {
    ready: auth.signInAnonymously(),
    async createGroup(name) { const id = rid(10); await gref(id).set({ name, created: Date.now() }); return id; },
    async renameGroup(g, name) { await gref(g).update({ name }); },
    watch(g, cb, onErr) {
      const st = { group: undefined, members: [], cars: [], trips: [], log: [] }, got = new Set();
      const emit = () => { if (got.size >= 5) cb(st); };
      gref(g).onSnapshot(s => { st.group = s.exists ? s.data() : null; got.add('group'); emit(); }, onErr);
      ['members', 'cars', 'trips'].forEach(c => gref(g).collection(c).onSnapshot(q => { st[c] = q.docs.map(d => ({ id: d.id, ...d.data() })); got.add(c); emit(); }, onErr));
      gref(g).collection('log').orderBy('ts', 'desc').limit(40).onSnapshot(q => { st.log = q.docs.map(d => ({ id: d.id, ...d.data() })); got.add('log'); emit(); }, onErr);
    },
    tx(g, reads, fn) {
      return db.runTransaction(async t => {
        const docs = {};
        for (const r of reads) { const s = await t.get(ref(g, r.col, r.id)); docs[r.col + '/' + r.id] = s.exists ? s.data() : null; }
        const writes = fn(docs);
        for (const w of writes) { const rf = ref(g, w.col, w.id); w.data === null ? t.delete(rf) : t.set(rf, w.data); }
        return writes;
      });
    }
  };
}
function memoryStore(seed) {
  const db = { members: {}, cars: {}, trips: {}, log: {} }; let group = seed.group, cb = null;
  ['members', 'cars', 'trips', 'log'].forEach(c => seed[c].forEach(d => { const { id, ...rest } = d; db[c][id] = JSON.parse(JSON.stringify(rest)); }));
  const snap = () => ({
    group, members: Object.entries(db.members).map(([id, d]) => ({ id, ...d })), cars: Object.entries(db.cars).map(([id, d]) => ({ id, ...d })),
    trips: Object.entries(db.trips).map(([id, d]) => ({ id, ...d })), log: Object.entries(db.log).map(([id, d]) => ({ id, ...d })).sort((a, b) => b.ts - a.ts).slice(0, 40)
  });
  const notify = () => cb && setTimeout(() => cb(JSON.parse(JSON.stringify(snap()))), 0);
  return {
    ready: Promise.resolve(),
    async createGroup() { return 'demo'; },
    async renameGroup(g, name) { group = { ...group, name }; notify(); },
    watch(g, f) { cb = f; notify(); },
    async tx(g, reads, fn) {
      const docs = {}; reads.forEach(r => { const d = db[r.col][r.id]; docs[r.col + '/' + r.id] = d ? JSON.parse(JSON.stringify(d)) : null; });
      const writes = fn(docs);
      writes.forEach(w => { if (w.data === null) delete db[w.col][w.id]; else db[w.col][w.id] = JSON.parse(JSON.stringify(w.data)); });
      notify(); return writes;
    }
  };
}

/* ---------- state ---------- */
let store = null, S = null, loadErr = null;
let ui = { tab: 'week', week: 0, sheet: null, toast: null, pin: '', pinFor: null, pinErr: false, confirm: null };
const meKey = () => 'dslc:me:' + GID;
const me = () => S && S.meId && S.members.find(m => m.id === S.meId) ? S.meId : null;
const mem = id => S.members.find(m => m.id === id);
const carOf = m => m && m.carId ? S.cars.find(c => c.id === m.carId) || null : null;
const nick = id => (mem(id) || { nick: 'Someone' }).nick;
const tripById = id => S.trips.find(t => t.id === id);

/* ---------- token & seat logic ---------- */
function alloc(t) {
  const c = cutoff(t.date);
  const rs = (t.riders || []).map(r => ({ ...r, late: r.ts > c }));
  rs.sort((a, b) => (a.late - b.late) || ((b.prio ? 1 : 0) - (a.prio ? 1 : 0)) || (a.ts - b.ts));
  return { conf: rs.slice(0, t.seats), wait: rs.slice(t.seats) };
}
function ledger() {
  const b = {}; S.members.forEach(m => b[m.id] = START);
  for (const t of S.trips) {
    if (t.date >= TODAY || !(t.driverId in b)) continue;
    for (const r of alloc(t).conf) { if (r.noShow || !(r.id in b)) continue; const c = COST[r.dir]; b[r.id] -= c; b[t.driverId] += c; }
  }
  return b;
}
function committed(id) { let s = 0; for (const t of S.trips) { if (t.date < TODAY) continue; const r = (t.riders || []).find(x => x.id === id); if (r) s += COST[r.dir]; } return s; }
function lastSeen(id) { let last = null; for (const t of S.trips) { if (t.driverId === id || (t.riders || []).some(r => r.id === id)) { if (!last || t.date > last) last = t.date; } } return last; }
function isActive(m) { const cut = ymd(addDays(new Date(), -QUIET_DAYS)); const l = lastSeen(m.id); return (l && l >= cut) || (m.joined || '') >= cut; }
function driveStats() {
  const st = {}; S.members.forEach(m => { if (m.carId) st[m.id] = { drives: 0, days: 0 }; });
  for (const t of S.trips) {
    if (t.date >= TODAY) continue;
    const conf = alloc(t).conf.filter(r => !r.noShow);
    if (st[t.driverId] && conf.length) { st[t.driverId].drives += COST[t.dir]; st[t.driverId].days += COST[t.dir]; }
    for (const r of conf) if (st[r.id]) st[r.id].days += COST[r.dir];
  }
  let D = 0, N = 0;
  const list = S.members.filter(m => m.carId && isActive(m)).map(m => { const s = st[m.id]; D += s.drives; N += s.days; return { id: m.id, ...s, ratio: s.days ? s.drives / s.days : null }; });
  const avg = N ? D / N : 0;
  list.forEach(x => { if (x.ratio === null) x.ratio = avg; });
  list.sort((a, b) => a.ratio - b.ratio || b.days - a.days);
  return { list, avg };
}

/* ---------- writing: every change is a transaction plus a log entry that can undo it ---------- */
async function act(text, reads, fn, toastText) {
  const who = me(); ui.sheet = null; ui.confirm = null; render();
  try {
    const w = await store.tx(GID, reads, docs => {
      const writes = fn(docs) || [];
      if (!writes.length) return [];
      const before = {};
      writes.forEach(x => { const k = x.col + '/' + x.id; before[k] = k in docs ? docs[k] : null; });
      writes.push({ col: 'log', id: rid(), data: { ts: Date.now(), who: who || writes.find(x => x.col === 'members')?.id || '', text, before: JSON.stringify(before), undone: false } });
      return writes;
    });
    if (w.length) toast(toastText || ('You ' + text));
  } catch (e) { console.error(e); toast(e.userMsg || 'That didn\'t save. Check your connection and try again.'); }
}
const fail = msg => { const e = new Error(msg); e.userMsg = msg; throw e; };
function toast(t) { ui.toast = t; clearTimeout(toast.h); render(); toast.h = setTimeout(() => { ui.toast = null; render(); }, 2800); }

/* ---------- handlers ---------- */
const val = id => { const e = document.getElementById(id); return e ? e.value : ''; };
function keepForm() { if (!ui.sheet) return; ['nick', 'plate', 'pin', 'share', 'gname'].forEach(k => { const e = document.getElementById('f-' + k); if (e) ui.sheet[k] = e.value; }); }

const H = {
  tab: v => { ui.tab = v; ui.sheet = null; render(); window.scrollTo(0, 0); },
  week: v => { ui.week = Math.max(-2, Math.min(3, ui.week + Number(v))); render(); },
  closeSheet: () => { ui.sheet = null; ui.confirm = null; render(); },
  noop: () => { },

  join: id => {
    const t = tripById(id), m = me(); if (!t || !m) return;
    const other = S.trips.find(x => x.date === t.date && x.id !== id && (x.riders || []).some(r => r.id === m));
    const prio = (ledger()[m] - committed(m)) > 0;
    const willWait = alloc({ ...t, riders: [...(t.riders || []), { id: m, ts: Date.now(), prio }] }).wait.some(r => r.id === m);
    const reads = [{ col: 'trips', id }]; if (other) reads.push({ col: 'trips', id: other.id });
    act(`joined ${nick(t.driverId)}'s car for ${dLabel(t.date)}`, reads, docs => {
      const T = docs['trips/' + id]; if (!T) fail('That lift has been cancelled.');
      if ((T.riders || []).some(r => r.id === m)) return [];
      const beforeConf = new Set(alloc(T).conf.map(r => r.id));
      const nt = { ...T, riders: [...(T.riders || []), { id: m, ts: Date.now(), prio, dir: T.dir }] };
      const w = [{ col: 'trips', id, data: nt }];
      if (other) { const O = docs['trips/' + other.id]; if (O) w.push({ col: 'trips', id: other.id, data: { ...O, riders: O.riders.filter(r => r.id !== m) } }); }
      const after = new Set(alloc(nt).conf.map(r => r.id));
      [...beforeConf].filter(x => !after.has(x)).forEach(x => w.push({ col: 'log', id: rid(), data: { ts: Date.now() + 1, who: x, text: `moved to the waitlist in ${nick(T.driverId)}'s car (someone with tokens took the seat)`, before: '{}', undone: true } }));
      return w;
    }, willWait ? "You're on the waitlist" : `You're in ${nick(t.driverId)}'s car`);
  },
  leave: id => {
    const t = tripById(id), m = me();
    act(`left ${nick(t.driverId)}'s car for ${dLabel(t.date)}`, [{ col: 'trips', id }], docs => {
      const T = docs['trips/' + id]; if (!T) return [];
      return [{ col: 'trips', id, data: { ...T, riders: T.riders.filter(r => r.id !== m) } }];
    });
  },
  riderSheet: id => { ui.sheet = { type: 'rider', trip: id }; render(); },
  setDir: (v, el) => {
    const id = el.dataset.t, t = tripById(id), m = me(), r = t.riders.find(x => x.id === m);
    if (!r || r.dir === v) { ui.sheet = null; render(); return; }
    act(`changed to ${DIRL[v].toLowerCase()} in ${nick(t.driverId)}'s car`, [{ col: 'trips', id }], docs => {
      const T = docs['trips/' + id]; if (!T) return [];
      return [{ col: 'trips', id, data: { ...T, riders: T.riders.map(x => x.id === m ? { ...x, dir: v } : x) } }];
    });
  },
  offer: date => { const c = carOf(mem(me())); ui.sheet = { type: 'post', date, dir: 'both', seats: c.cap - 1 }; render(); },
  editTrip: id => { const t = tripById(id); ui.sheet = { type: 'post', trip: id, date: t.date, dir: t.dir, seats: t.seats }; render(); },
  sdir: v => { ui.sheet.dir = v; render(); },
  sseat: v => { const max = carOf(mem(me())).cap - 1; ui.sheet.seats = Math.max(1, Math.min(max, ui.sheet.seats + Number(v))); render(); },
  savePost: () => {
    const s = { ...ui.sheet }, m = me();
    if (s.trip) {
      act(`updated your lift for ${dLabel(s.date)}`, [{ col: 'trips', id: s.trip }], docs => {
        const T = docs['trips/' + s.trip]; if (!T) fail('That lift no longer exists.');
        return [{ col: 'trips', id: s.trip, data: { ...T, dir: s.dir, seats: s.seats, riders: T.riders.map(r => s.dir !== 'both' ? { ...r, dir: s.dir } : r) } }];
      }, 'Lift updated');
    } else {
      const mine = S.trips.filter(x => x.date === s.date && (x.riders || []).some(r => r.id === m));
      act(`offered a lift for ${dLabel(s.date)}`, mine.map(x => ({ col: 'trips', id: x.id })), docs => {
        const w = [{ col: 'trips', id: rid(), data: { date: s.date, driverId: m, dir: s.dir, seats: s.seats, riders: [], created: Date.now() } }];
        mine.forEach(x => { const O = docs['trips/' + x.id]; if (O) w.push({ col: 'trips', id: x.id, data: { ...O, riders: O.riders.filter(r => r.id !== m) } }); });
        return w;
      }, 'Lift posted. People can hop in now.');
    }
  },
  cancelTrip: () => {
    if (ui.confirm !== 'cancel') { ui.confirm = 'cancel'; render(); return; }
    const id = ui.sheet.trip, t = tripById(id);
    act(`cancelled your lift for ${dLabel(t.date)}`, [{ col: 'trips', id }], docs => docs['trips/' + id] ? [{ col: 'trips', id, data: null }] : [], 'Lift cancelled');
  },
  noShow: (v, el) => {
    const id = el.dataset.t, t = tripById(id), r = t.riders.find(x => x.id === v);
    act(`marked ${nick(v)} as ${r.noShow ? 'there' : "didn't come"} on ${dLabel(t.date)}`, [{ col: 'trips', id }], docs => {
      const T = docs['trips/' + id]; if (!T) return [];
      return [{ col: 'trips', id, data: { ...T, riders: T.riders.map(x => x.id === v ? { ...x, noShow: !x.noShow } : x) } }];
    });
  },
  undo: () => {
    const L = S.log[0], before = JSON.parse(L.before || '{}');
    store.tx(GID, [{ col: 'log', id: L.id }], docs => {
      const LL = docs['log/' + L.id]; if (!LL || LL.undone) fail('That was already undone.');
      const w = Object.keys(before).map(k => { const [col, id] = k.split('/'); return { col, id, data: before[k] }; });
      w.push({ col: 'log', id: L.id, data: { ...LL, undone: true } });
      w.push({ col: 'log', id: rid(), data: { ts: Date.now(), who: me(), text: `undid “${L.text}”`, before: '{}', undone: true } });
      return w;
    }).then(() => toast('Undone'), e => toast(e.userMsg || 'Couldn\'t undo that.'));
  },

  // members & cars
  addSheet: () => { ui.sheet = { type: 'member', car: 'none', cap: 5 }; render(); },
  memberSheet: id => { const m = mem(id), c = carOf(m); const shared = c && S.members.some(x => x.id !== id && x.carId === c.id);
    ui.sheet = { type: 'member', edit: id, nick: m.nick, car: !c ? 'none' : shared ? 'share' : 'own', plate: c ? c.plate : '', cap: c ? c.cap : 5, share: c ? c.id : '' }; render(); },
  acar: v => { keepForm(); ui.sheet.car = v; ui.sheet.err = null; render(); },
  acap: v => { keepForm(); ui.sheet.cap = Math.max(3, Math.min(7, ui.sheet.cap + Number(v))); render(); },
  saveMember: () => {
    keepForm(); const s = ui.sheet, n = (s.nick || '').trim(), fresh = !me() && !s.edit;
    const err = msg => { ui.sheet.err = msg; render(); };
    if (!n) return err('Add a nickname first.');
    if (S.members.some(m => m.id !== s.edit && m.nick.toLowerCase() === n.toLowerCase())) return err(`There's already someone called ${n}. Try another nickname.`);
    if (fresh && !/^\d{4}$/.test(s.pin || '')) return err('Pick a PIN of exactly four numbers.');
    if (s.car === 'share' && !s.share) return err('Choose whose car it is.');
    const id = s.edit || rid(), old = s.edit ? mem(s.edit) : null, oldCar = old ? carOf(old) : null;
    const oldCarShared = oldCar && S.members.some(x => x.id !== id && x.carId === oldCar.id);
    const writes = []; let carId = null;
    if (s.car === 'own') {
      const plate = ((s.plate || '').trim() || 'Car').toUpperCase().slice(0, 12);
      if (oldCar && !oldCarShared) { carId = oldCar.id; writes.push({ col: 'cars', id: carId, data: { plate, cap: s.cap } }); }
      else { carId = rid(); writes.push({ col: 'cars', id: carId, data: { plate, cap: s.cap } }); }
    } else if (s.car === 'share') carId = s.share;
    const data = old ? { ...stripId(old), nick: n, carId } : { nick: n, carId, joined: TODAY, pinHash: fresh ? pinHash(id, s.pin) : null };
    writes.push({ col: 'members', id, data });
    const reads = writes.map(w => ({ col: w.col, id: w.id }));
    if (fresh) { S.meId = id; ls.set(meKey(), id); }
    act(fresh ? 'joined the group' : s.edit ? (s.edit === me() ? 'updated your details' : `updated ${n}'s details`) : `added ${n} to the group`, reads, () => writes,
      fresh ? `Welcome, ${n}` : s.edit ? 'Saved' : `${n} added. They can log in from the invite link.`);
  },
  resetPin: () => {
    if (ui.confirm !== 'pin') { ui.confirm = 'pin'; render(); return; }
    const id = ui.sheet.edit;
    act(`reset ${nick(id)}'s PIN`, [{ col: 'members', id }], docs => docs['members/' + id] ? [{ col: 'members', id, data: { ...docs['members/' + id], pinHash: null } }] : [],
      `${nick(id)} can choose a new PIN next time they log in`);
  },

  // login
  pick: id => { ui.pinFor = id; ui.pin = ''; ui.pinErr = false; render(); },
  backPick: () => { ui.pinFor = null; ui.pin = ''; render(); },
  pinKey: v => {
    if (v === 'del') ui.pin = ui.pin.slice(0, -1); else if (ui.pin.length < 4) ui.pin += v;
    ui.pinErr = false;
    if (ui.pin.length === 4) {
      const m = mem(ui.pinFor), h = pinHash(m.id, ui.pin);
      if (!m.pinHash) {
        S.meId = m.id; ls.set(meKey(), m.id);
        act('set a new PIN', [{ col: 'members', id: m.id }], docs => [{ col: 'members', id: m.id, data: { ...docs['members/' + m.id], pinHash: h } }], `Hi ${m.nick}. Your PIN is set, and you'll stay logged in on this phone.`);
        ui.pinFor = null; ui.pin = ''; ui.tab = 'week'; render(); return;
      }
      if (h === m.pinHash) { S.meId = m.id; ls.set(meKey(), m.id); ui.pinFor = null; ui.pin = ''; ui.tab = 'week'; toast(`Hi ${m.nick}. You'll stay logged in on this phone.`); return; }
      ui.pin = ''; ui.pinErr = true;
    }
    render();
  },
  newMe: () => { ui.sheet = { type: 'member', car: 'none', cap: 5 }; render(); },
  logout: () => { if (ui.confirm !== 'logout') { ui.confirm = 'logout'; render(); return; } ls.set(meKey(), null); S.meId = null; ui.confirm = null; ui.tab = 'week'; render(); },
  guideSheet: () => { ui.sheet = { type: 'guide' }; render(); },

  // groups
  copy: () => {
    const t = inviteUrl(), done = () => toast('Invite link copied. Paste it in the WhatsApp group.');
    try { navigator.clipboard.writeText(t).then(done, () => { selectText(document.getElementById('invite')); toast('Press and hold the link to copy it'); }); }
    catch (e) { selectText(document.getElementById('invite')); }
  },
  renameSheet: () => { ui.sheet = { type: 'rename', gname: S.group.name }; render(); },
  saveRename: () => { keepForm(); const n = (ui.sheet.gname || '').trim().slice(0, 40); if (!n) return; ui.sheet = null;
    store.renameGroup(GID, n).then(() => toast('Group renamed'), () => toast('That didn\'t save. Try again.')); },
  createGroup: () => {
    const n = val('f-gname').trim().slice(0, 40); if (!n) { ui.landErr = 'Give your lift club a name.'; render(); return; }
    ui.creating = true; render();
    store.createGroup(n).then(id => { location.search = '?g=' + id; }, e => { console.error(e); ui.creating = false; ui.landErr = 'Couldn\'t create the group. Check your connection and the setup steps.'; render(); });
  },
};
function stripId(o) { const { id, ...r } = o; return r; }
function selectText(el) { try { const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) { } }
document.addEventListener('click', e => { const el = e.target.closest('[data-a]'); if (!el) return; const f = H[el.dataset.a]; if (f) f(el.dataset.v, el, e); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && ui.sheet) H.closeSheet(); });

/* ---------- views ---------- */
const coin = n => `<span class="coinpill ${n < 0 ? 'neg' : ''}"><span class="coin">T</span><span class="num">${fmt(n)}</span></span>`;
const ICON = {
  week: '<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  dash: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M9.5 9.5h3.8a1.7 1.7 0 0 1 0 3.4H10.7a1.7 1.7 0 0 0 0 3.4h3.8"/></svg>',
  guide: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.5M12 16.8v.2"/></svg>',
  group: '<svg viewBox="0 0 24 24"><circle cx="9" cy="9" r="3.2"/><path d="M3.5 19c.6-3 2.8-4.6 5.5-4.6s4.9 1.6 5.5 4.6"/><circle cx="17" cy="8" r="2.5"/><path d="M15.8 13.6c2.4-.3 4.3 1 4.8 3.9"/></svg>'
};

function render() {
  TODAY = ymd(new Date());
  const app = document.getElementById('app'); let h = '';
  if (loadErr) h = viewMessage('Can\'t reach the lift club', loadErr);
  else if (!store) h = viewMessage('Almost ready', 'The app hasn\'t been connected to Firebase yet. Follow SETUP.md to paste your Firebase settings into firebase-config.js. To try it with sample data, add <code>?demo</code> to the end of the address.');
  else if (!GID) h = viewLanding();
  else if (!S) h = `<p class="quiet" style="padding:40px 0">Loading…</p>`;
  else if (S.group === null) h = viewMessage('This link doesn\'t work', 'The lift club couldn\'t be found. Ask someone in the group to copy the invite link again from the Group page.');
  else {
    document.title = S.group.name;
    if (DEMO) h += `<div class="proto"><span>Demo with made-up people. Changes vanish when you reload.</span></div>`;
    if (!me()) h += viewLogin();
    else {
      const b = ledger(), m = mem(me());
      h += `<header class="top"><div><h1>${esc(S.group.name)}</h1><div class="who">Logged in as ${esc(m.nick)}</div></div>${coin(b[m.id])}</header>`;
      h += ui.tab === 'week' ? viewWeek() : ui.tab === 'dash' ? viewDash(b) : ui.tab === 'guide' ? `<div style="padding-top:4px">${guideHTML()}</div>` : viewGroup(b);
      h += `<nav class="tabs"><div>${[['week', 'This week'], ['dash', 'Dashboard'], ['group', 'Group'], ['guide', 'How it works']].map(([k, l]) => `<button data-a="tab" data-v="${k}" ${ui.tab === k ? 'aria-current="page"' : ''}>${ICON[k]}${l}</button>`).join('')}</div></nav>`;
    }
    if (ui.sheet) h += viewSheet();
  }
  if (ui.toast) h += `<div class="toast" role="status">${esc(ui.toast)}</div>`;
  const focus = document.activeElement && document.activeElement.id;
  app.innerHTML = h;
  if (focus && document.getElementById(focus)) document.getElementById(focus).focus();
}
function viewMessage(title, body) { return `<div class="center"><h1>${esc(title)}</h1><p style="margin:0;color:var(--muted)">${body}</p></div>`; }

function viewLanding() {
  const last = ls.get('dslc:last');
  return `<div class="center"><h1>Start a lift club</h1>
    <p style="margin:0;color:var(--muted)">Already in one? Open the invite link someone shared in your WhatsApp group.</p>
    ${last ? `<a class="btn sec block" href="?g=${esc(last)}">Open my lift club</a>` : ''}
    <div class="field"><label for="f-gname">Name of the new lift club</label><input id="f-gname" maxlength="40" placeholder="Deep South Lift Club" autocomplete="off"></div>
    ${ui.landErr ? `<p class="err">${esc(ui.landErr)}</p>` : ''}
    <button class="btn pri block" data-a="createGroup" ${ui.creating ? 'disabled' : ''}>${ui.creating ? 'Creating…' : 'Create lift club'}</button>
    <p class="note">You'll get an invite link to share. Everyone in the group can add people, so there's no admin.</p></div>`;
}

function viewLogin() {
  if (ui.pinFor) {
    const m = mem(ui.pinFor); if (!m) { ui.pinFor = null; return viewLogin(); }
    const dots = [0, 1, 2, 3].map(i => `<span class="${i < ui.pin.length ? 'on' : ''}"></span>`).join('');
    return `<div class="login"><button class="link" data-a="backPick" style="align-self:flex-start">‹ Not ${esc(m.nick)}?</button>
      <h1>Hi ${esc(m.nick)}</h1><p class="note" style="margin:0">${m.pinHash ? 'Enter your 4-digit PIN.' : 'Choose a 4-digit PIN. You\'ll only need it if you log in on another phone.'}</p>
      <div class="pin ${ui.pinErr ? 'shake' : ''}">${dots}</div>
      ${ui.pinErr ? '<p class="err" style="text-align:center">That PIN doesn\'t match. Forgotten it? Anyone in the group can reset it from the Group page.</p>' : ''}
      <div class="pad">${['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map(k => k === '' ? '<span></span>' : `<button data-a="pinKey" data-v="${k}" aria-label="${k === 'del' ? 'Delete' : k}">${k === 'del' ? '⌫' : k}</button>`).join('')}</div></div>`;
  }
  const act = S.members.filter(isActive).sort((a, b) => a.nick.localeCompare(b.nick)), q = S.members.filter(m => !isActive(m));
  return `<div class="login"><h1>${esc(S.group.name)}</h1>
    ${S.members.length ? '<p style="margin:0;color:var(--muted)">Who are you? Tap your nickname.</p>' : '<p style="margin:0;color:var(--muted)">Nobody has joined yet. Be the first.</p>'}
    <div class="names">${act.map(m => `<button data-a="pick" data-v="${m.id}">${esc(m.nick)}</button>`).join('')}</div>
    ${q.length ? `<details><summary>Haven't been in for a while (${q.length})</summary><div class="names">${q.map(m => `<button data-a="pick" data-v="${m.id}">${esc(m.nick)}</button>`).join('')}</div></details>` : ''}
    <button class="btn ${S.members.length ? 'ghost' : 'pri'} block" data-a="newMe">I'm new here</button>
    <button class="link" data-a="guideSheet">How does this work?</button></div>`;
}

function viewWeek() {
  const mon = addDays(mondayOf(new Date()), ui.week * 7), fri = addDays(mon, 4);
  const label = { '-2': 'Two weeks ago', '-1': 'Last week', '0': 'This week', '1': 'Next week' }[ui.week] || `In ${ui.week} weeks`;
  let h = `<div class="weeknav"><button data-a="week" data-v="-1" aria-label="Previous week" ${ui.week <= -2 ? 'disabled' : ''}>‹</button><h2>${label} · ${mon.getDate()} ${MON[mon.getMonth()]} – ${fri.getDate()} ${MON[fri.getMonth()]}</h2><button data-a="week" data-v="1" aria-label="Next week" ${ui.week >= 3 ? 'disabled' : ''}>›</button></div>`;
  const m = mem(me()), myCar = carOf(m), stats = driveStats();
  for (let i = 0; i < 5; i++) {
    const ds = ymd(addDays(mon, i)), past = ds < TODAY;
    const trips = S.trips.filter(t => t.date === ds && mem(t.driverId)).sort((a, b) => (a.created || 0) - (b.created || 0));
    const iDrive = trips.some(t => t.driverId === m.id);
    const carBusy = myCar && trips.some(t => t.driverId !== m.id && mem(t.driverId).carId === myCar.id);
    let body = trips.map(t => tripCard(t, past)).join('');
    if (!past) {
      const waiting = trips.reduce((s, t) => s + alloc(t).wait.length, 0);
      if (waiting) {
        const next = stats.list.filter(x => !trips.some(t => t.driverId === x.id || mem(t.driverId).carId === mem(x.id).carId)).slice(0, 3).map(x => esc(nick(x.id)));
        body += `<div class="banner"><div><b>${waiting} ${waiting === 1 ? 'person is' : 'people are'} waiting for a seat.</b> Another car would sort it out.${next.length ? ` Next up to drive: ${next.join(', ')}.` : ''}</div>${myCar && !iDrive && !carBusy ? `<div><button class="btn pri" data-a="offer" data-v="${ds}">I'll take my car</button></div>` : ''}</div>`;
      } else if (!trips.length) {
        body += `<div class="offer"><span class="quiet">Nobody's driving yet.</span>${myCar && !carBusy ? `<button class="btn sec" data-a="offer" data-v="${ds}">I'm driving</button>` : ''}</div>`;
      } else if (myCar && !iDrive && !carBusy) {
        body += `<button class="link" style="align-self:flex-start" data-a="offer" data-v="${ds}">+ I'm driving too</button>`;
      }
    } else if (!trips.length) body += `<div class="quiet">No lifts</div>`;
    const d = parse(ds);
    h += `<section class="day ${past ? 'past' : ''}"><div><div class="dname">${DAYN[d.getDay()]}</div><div class="ddate">${d.getDate()} ${MON[d.getMonth()]}</div>${ds === TODAY ? '<span class="today">Today</span>' : ''}</div><div class="dbody">${body}</div></section>`;
  }
  return h;
}

function tripCard(t, past) {
  const { conf, wait } = alloc(t), d = mem(t.driverId), car = carOf(d), m = me(), mineDrive = t.driverId === m;
  const myR = (t.riders || []).find(r => r.id === m), beforeCut = Date.now() < cutoff(t.date);
  const chip = (r, kind) => {
    const isMe = r.id === m, prov = kind === 'conf' && !r.prio && beforeCut && !past;
    const extra = r.dir !== t.dir ? `<small>${r.dir === 'in' ? 'in only' : 'home only'}</small>` : '';
    const cls = `chip ${isMe ? 'me' : ''} ${prov ? 'prov' : ''} ${r.noShow ? 'noshow' : ''}`, label = esc(nick(r.id)) + extra;
    if (past && mineDrive && kind === 'conf') return `<button class="${cls}" data-a="noShow" data-v="${r.id}" data-t="${t.id}" title="Tap if they didn't come">${label}</button>`;
    if (!past && isMe) return `<button class="${cls}" data-a="riderSheet" data-v="${t.id}">${label} ▾</button>`;
    return `<span class="${cls}">${label}</span>`;
  };
  const dots = Array.from({ length: t.seats }, (_, i) => `<span class="seat ${i < conf.length ? 'on' : ''}"></span>`).join('');
  const tk = n => `${fmt(n)} token${n === 1 ? '' : 's'}`;
  let foot = '';
  if (past) {
    const earned = conf.filter(r => !r.noShow).reduce((s, r) => s + COST[r.dir], 0);
    if (mineDrive) foot = `<span class="note">You earned ${tk(earned)}.${conf.length ? ' Tap anyone who didn\'t come.' : ''}</span>`;
    else if (myR && !myR.noShow && conf.some(r => r.id === m)) foot = `<span class="note">You paid ${tk(COST[myR.dir])}</span>`;
    else foot = `<span class="note">${esc(d.nick)} earned ${fmt(earned)}</span>`;
  } else if (mineDrive) {
    foot = `<span class="note">${t.date === TODAY ? 'Tokens move automatically tonight.' : `${conf.length} of ${t.seats} seats taken`}</span><button class="btn ghost" data-a="editTrip" data-v="${t.id}">Edit</button>`;
  } else if (myR) {
    const inConf = conf.some(r => r.id === m), prov = inConf && !myR.prio && beforeCut;
    foot = `<span class="note">${!inConf ? 'You\'re on the waitlist. You\'ll get a seat if one opens up.' : prov ? 'Your seat is held until 9pm the night before. Someone with tokens could still take it.' : `You're in. ${tk(COST[myR.dir])}.`}</span><button class="btn ghost" data-a="leave" data-v="${t.id}">Leave</button>`;
  } else {
    const full = conf.length >= t.seats, left = t.seats - conf.length;
    const seatedElsewhere = S.trips.some(x => x.date === t.date && x.id !== t.id && alloc(x).conf.some(r => r.id === m));
    const btn = seatedElsewhere ? (full ? '' : `<button class="btn ghost" data-a="join" data-v="${t.id}">Switch to this car</button>`)
      : `<button class="btn ${full ? 'ghost' : 'pri'}" data-a="join" data-v="${t.id}">${full ? 'Join waitlist' : "I'm in"}</button>`;
    foot = `<span class="note">${full ? 'Full' : `${left} seat${left === 1 ? '' : 's'} left`}</span>${btn}`;
  }
  return `<article class="trip ${mineDrive || myR ? 'mine' : ''}">
    <div class="thead"><span class="tdriver">${esc(d.nick)}${mineDrive ? ' (you)' : ''}</span>${car ? `<span class="plate">${esc(car.plate)}</span>` : ''}<span class="dir">${DIRL[t.dir]}</span><span class="seats" aria-label="${conf.length} of ${t.seats} seats taken">${dots}</span></div>
    ${conf.length ? `<div class="chips">${conf.map(r => chip(r, 'conf')).join('')}</div>` : `<div class="quiet" style="padding:0">${past ? 'Drove alone' : 'No passengers yet'}</div>`}
    ${wait.length ? `<div class="wlabel">Waiting</div><div class="chips">${wait.map(r => chip(r, 'wait')).join('')}</div>` : ''}
    <div class="tfoot">${foot}</div></article>`;
}

function viewDash(b) {
  const m = me(), avail = b[m] - committed(m), stats = driveStats();
  const mon = ymd(mondayOf(new Date())), sun = ymd(addDays(mondayOf(new Date()), 6));
  const wk = S.trips.filter(t => t.date >= mon && t.date <= sun);
  let seats = 0, tok = 0, waiting = 0;
  wk.forEach(t => { const a = alloc(t); seats += a.conf.length; tok += a.conf.reduce((s, r) => s + COST[r.dir], 0); if (t.date >= TODAY) waiting += a.wait.length; });
  let h = `<div class="hero"><span class="coin">T</span><div><div class="big num">${fmt(b[m])}</div><div class="note">${b[m] < 0 ? 'You owe the group a few lifts. You can still book, you\'ll just be behind people with tokens.' : committed(m) ? `${fmt(avail)} left after the lifts you've booked` : 'tokens to spend on lifts'}</div></div></div>`;
  const up = stats.list.slice(0, 3);
  h += `<div class="sec-h">Up next to drive</div><div class="rows">${up.map((x, i) => `<div class="row"><span class="rank">${i + 1}</span><div class="grow"><b>${esc(nick(x.id))}${x.id === m ? ' (you)' : ''}</b><div class="sub">Drove ${fmt(x.drives)} of ${fmt(x.days)} office day${x.days === 1 ? '' : 's'}</div></div></div>`).join('') || '<div class="row note">This fills in once a few lifts have happened.</div>'}</div>`;
  h += `<div class="sec-h">This week</div><div class="stats">
    <div class="stat"><b class="num">${wk.length}</b><span>cars on the road</span></div>
    <div class="stat"><b class="num">${seats}</b><span>seats shared</span></div>
    <div class="stat"><b class="num">${fmt(tok)}</b><span>tokens changing hands</span></div>
    <div class="stat"><b class="num">${waiting}</b><span>waiting for a seat</span></div></div>`;
  if (stats.list.length) h += `<div class="sec-h">Driving share</div><div class="rows">${stats.list.slice().reverse().map(x => `<div class="row"><div class="grow"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(nick(x.id))}</b><span class="sub num">${fmt(x.drives)} / ${fmt(x.days)} days</span></div><div class="share"><i style="width:${Math.min(100, x.ratio * 100)}%"></i><u style="left:${Math.min(100, stats.avg * 100)}%"></u></div></div></div>`).join('')}</div>
    <p class="note">Bar = share of your office days you drove. The line marks the group average. Driving alone doesn't count, and people who rarely come in aren't penalised.</p>`;
  const act = S.members.filter(isActive).sort((x, y) => b[y.id] - b[x.id]);
  h += `<div class="sec-h">Tokens</div><div class="rows">${act.map(x => `<div class="row"><div class="grow"><b>${esc(x.nick)}${x.id === m ? ' (you)' : ''}</b>${x.carId ? '' : '<span class="sub"> · no car</span>'}</div><span class="val num ${b[x.id] < 0 ? 'neg' : ''}">${fmt(b[x.id])}</span></div>`).join('')}</div>`;
  return h;
}

function viewGroup(b) {
  const act = S.members.filter(isActive).sort((a, c) => a.nick.localeCompare(c.nick)), q = S.members.filter(m => !isActive(m));
  const row = m => { const c = carOf(m), shared = c && S.members.filter(x => x.carId === c.id).length > 1;
    return `<button class="row tap" data-a="memberSheet" data-v="${m.id}"><div class="grow"><b>${esc(m.nick)}${m.id === me() ? ' (you)' : ''}</b><div class="sub">${c ? `<span class="plate">${esc(c.plate)}</span> ${c.cap} seats${shared ? ' · shared car' : ''}` : 'No car'}</div></div><span class="val num ${b[m.id] < 0 ? 'neg' : ''}">${fmt(b[m.id])}</span></button>`; };
  const L = S.log[0], canUndo = L && !L.undone && L.who === me() && Date.now() - L.ts < UNDO_MINUTES * 60000 && L.before && L.before !== '{}';
  return `<div class="sec-h" style="margin-top:8px">Invite people</div><div class="invite"><code id="invite">${esc(DEMO ? 'Invite links work once the app is connected' : inviteUrl())}</code><button class="btn sec" data-a="copy">Copy</button></div>
    <p class="note">Anyone with this link can join and add others. No admin needed.</p>
    <div class="sec-h">Members (${act.length})</div><div class="rows">${act.map(row).join('') || '<div class="row note">No one yet.</div>'}</div>
    ${q.length ? `<details><summary>Not in for a while (${q.length}). Their tokens are kept for when they're back.</summary><div class="rows">${q.map(row).join('')}</div></details>` : ''}
    <p class="note">Tap someone to change their car or reset their PIN.</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px"><button class="btn pri" data-a="addSheet">Add someone</button><button class="btn ghost" data-a="renameSheet">Rename group</button><a class="btn ghost" href="${location.pathname}">Start another group</a></div>
    <div class="sec-h">Recent activity</div><div class="rows log">${S.log.slice(0, 20).map((l, i) => `<div class="row"><div class="grow"><b>${esc(nick(l.who))}</b> ${esc(l.text)}</div>${i === 0 && canUndo ? '<button class="link" data-a="undo">Undo</button>' : `<time>${ago(l.ts)}</time>`}</div>`).join('') || '<div class="row note">Nothing yet.</div>'}</div>
    <p class="note">Anyone can fix a mistake, and every change shows up here. You can undo your own last change for ${UNDO_MINUTES} minutes.</p>
    <div style="margin-top:20px"><button class="btn ghost" data-a="logout">${ui.confirm === 'logout' ? 'Tap again to log out' : 'Log out on this phone'}</button></div>`;
}

function viewSheet() {
  const s = ui.sheet; let inner = '';
  if (s.type === 'post') {
    const max = carOf(mem(me())).cap - 1;
    inner = `<h3>${s.trip ? 'Edit your lift' : "You're driving"} · ${dLabel(s.date)}</h3>
      <div class="field"><span>Which way?</span><div class="seg">${['both', 'in', 'home'].map(d => `<button data-a="sdir" data-v="${d}" aria-pressed="${s.dir === d}">${d === 'both' ? 'There & back' : d === 'in' ? 'In only' : 'Home only'}</button>`).join('')}</div></div>
      <div class="field"><span>Seats for passengers</span><div class="stepper"><button data-a="sseat" data-v="-1" aria-label="Fewer seats">−</button><b class="num">${s.seats}</b><button data-a="sseat" data-v="1" aria-label="More seats">+</button><span class="note">Your car takes ${max} passenger${max === 1 ? '' : 's'}</span></div></div>
      <button class="btn pri block" data-a="savePost">${s.trip ? 'Save changes' : 'Post my lift'}</button>
      ${s.trip ? `<button class="btn danger block" data-a="cancelTrip">${ui.confirm === 'cancel' ? 'Tap again to cancel this lift' : 'Cancel this lift'}</button>` : ''}`;
  } else if (s.type === 'rider') {
    const t = tripById(s.trip); if (!t) { ui.sheet = null; return ''; }
    const r = t.riders.find(x => x.id === me()) || {}, opts = t.dir === 'both' ? ['both', 'in', 'home'] : [t.dir];
    inner = `<h3>${esc(nick(t.driverId))}'s car · ${dLabel(t.date)}</h3>
      ${opts.length > 1 ? `<div class="field"><span>Which way are you riding?</span><div class="seg">${opts.map(d => `<button data-a="setDir" data-v="${d}" data-t="${t.id}" aria-pressed="${r.dir === d}">${d === 'both' ? 'There & back · 1' : d === 'in' ? 'In only · ½' : 'Home only · ½'}</button>`).join('')}</div></div>` : ''}
      <button class="btn danger block" data-a="leave" data-v="${t.id}">Leave this car</button>`;
  } else if (s.type === 'guide') {
    inner = guideHTML() + '<button class="btn pri block" data-a="closeSheet">Got it</button>';
  } else if (s.type === 'rename') {
    inner = `<h3>Rename group</h3><div class="field"><label for="f-gname">Name</label><input id="f-gname" maxlength="40" value="${esc(s.gname || '')}" autocomplete="off"></div><button class="btn pri block" data-a="saveRename">Save</button>`;
  } else if (s.type === 'member') {
    const fresh = !me() && !s.edit;
    const shareable = S.cars.filter(c => S.members.some(m => m.carId === c.id && m.id !== s.edit));
    const title = fresh ? 'Join the lift club' : s.edit ? (s.edit === me() ? 'Your details' : esc(nick(s.edit))) : 'Add someone';
    inner = `<h3>${title}</h3>
      <div class="field"><label for="f-nick">Nickname</label><input id="f-nick" maxlength="20" placeholder="e.g. Mo" value="${esc(s.nick || '')}" autocomplete="off"></div>
      <div class="field"><span>Car</span><div class="seg">${[['none', 'No car'], ['own', 'Own car'], ['share', 'Shares a car']].map(([k, l]) => `<button data-a="acar" data-v="${k}" aria-pressed="${s.car === k}">${l}</button>`).join('')}</div></div>
      ${s.car === 'own' ? `<div class="field"><label for="f-plate">Number plate (helps people spot the car)</label><input id="f-plate" maxlength="12" placeholder="CL 12-345" value="${esc(s.plate || '')}" autocomplete="off"></div>
        <div class="field"><span>People the car fits, driver included</span><div class="stepper"><button data-a="acap" data-v="-1" aria-label="Fewer">−</button><b class="num">${s.cap}</b><button data-a="acap" data-v="1" aria-label="More">+</button></div></div>` : ''}
      ${s.car === 'share' ? (shareable.length ? `<div class="field"><label for="f-share">Whose car?</label><select id="f-share">${shareable.map(c => `<option value="${c.id}" ${s.share === c.id ? 'selected' : ''}>${esc(S.members.filter(m => m.carId === c.id).map(m => m.nick).join(' & '))} · ${esc(c.plate)}</option>`).join('')}</select></div>` : '<p class="note" style="margin:0">No cars added yet. Choose Own car instead.</p>') : ''}
      ${fresh ? `<div class="field"><label for="f-pin">Choose a 4-digit PIN</label><input id="f-pin" inputmode="numeric" pattern="[0-9]*" maxlength="4" value="${esc(s.pin || '')}" autocomplete="off"><span class="note">It only stops someone else booking as you. Don't reuse a bank PIN.</span></div>` : ''}
      ${s.err ? `<p class="err">${esc(s.err)}</p>` : ''}
      ${s.edit ? '' : '<p class="note" style="margin:0">Everyone starts with 5 tokens.</p>'}
      <button class="btn pri block" data-a="saveMember">${fresh ? 'Join' : s.edit ? 'Save' : 'Add to group'}</button>
      ${s.edit && mem(s.edit).pinHash ? `<button class="btn ghost block" data-a="resetPin">${ui.confirm === 'pin' ? 'Tap again to reset the PIN' : 'Reset PIN'}</button>` : ''}`;
  }
  return `<div class="scrim" data-a="closeSheet"><div class="sheet" data-a="noop" role="dialog" aria-modal="true"><div class="grab"></div>${inner}</div></div>`;
}

function guideHTML() {
  const sec = (t, items) => `<section class="gsec"><h3>${t}</h3><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul></section>`;
  return `<div class="guide">
  <p class="lede">A fair way to share lifts. Drive and you earn tokens, ride and you spend them. Over time everyone gives about as much as they take.</p>
  <table class="gtable"><thead><tr><th>What happens</th><th class="num">Tokens</th></tr></thead><tbody>
    <tr><td>You start with</td><td class="num">+5</td></tr>
    <tr><td>Ride there &amp; back</td><td class="num">−1</td></tr>
    <tr><td>Ride one way</td><td class="num">−½</td></tr>
    <tr><td>Drive, per passenger there &amp; back</td><td class="num">+1</td></tr>
    <tr><td>Drive, per passenger one way</td><td class="num">+½</td></tr>
    <tr><td>Drive alone</td><td class="num">0</td></tr></tbody></table>
  <p class="note">Example: you drive in with three people who all ride home with you too. You earn 3 tokens, and each of them pays 1.</p>
  ${sec('Getting a lift', ['Open <b>This week</b>, find a car and tap <b>I\'m in</b>.', 'Only riding one way? Tap your name on the car and choose <b>In only</b> or <b>Home only</b>.', 'Plans changed? Tap <b>Leave</b>. If it\'s last-minute, give the driver a heads-up on WhatsApp too.'])}
  ${sec('Driving', ['Tap <b>I\'m driving</b> on the day. Seats fill in from your car, and you can change them.', 'Posting the lift is the record. Tokens move automatically the evening after the trip, so there\'s nothing to log.', 'If someone didn\'t turn up, tap their name on the past trip so they aren\'t charged.', 'Couples who share a car each count as their own person. Each takes their own turns driving, and each pays when riding.'])}
  ${sec('When cars fill up', ['Seats go first come, first served to people who have tokens.', 'Out of tokens? You can still book. Your seat is held until <b>9pm the night before</b>, but someone with tokens can take it before then.', 'After 9pm the night before, the list is locked.', 'If people are waiting, the app asks for another car and suggests who\'s next to drive.'])}
  ${sec('Who should drive next?', ['The <b>Dashboard</b> shows each driver\'s share: how many of their office days they drove.', '<b>Up next to drive</b> lists the people furthest behind. If your name is there, offer next time you go in.', 'It counts only days you actually come in, so weeks of working from home don\'t count against you. Driving alone doesn\'t count either.'])}
  ${sec('Going below zero', ['That\'s fine. You\'ll still get lifts, just after people with tokens when cars are full.', 'If you have a car, offering a lift is the quickest way back up.', 'If you don\'t have a car, your balance will drift down over time. That\'s expected.'])}
  ${sec('Keeping it fair', ['There\'s no admin. Anyone can add people, fix a trip or change someone\'s car details.', 'Every change shows under <b>Recent activity</b> in Group, so it stays honest.', 'Haven\'t been in for four weeks? You drop off the lists, and your tokens wait for you.'])}
  ${sec('Joining', ['Open the invite link from the WhatsApp group, tap <b>I\'m new here</b>, and pick a nickname and a 4-digit PIN.', 'No real names, emails or phone numbers needed. You stay logged in on your phone.', 'Tip: add the page to your home screen so it opens like an app.'])}
  ${sec('What stays on WhatsApp', ['Departure times, pick-up spots and "running late" messages. The app only keeps track of who\'s driving, who\'s riding and the tokens.'])}
  </div>`;
}

/* ---------- demo data ---------- */
function demoSeed() {
  const today = parse(TODAY); let seed = 11; const r = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const cars = [['c1', 'CL 48-221', 5], ['c2', 'CL 19-760', 4], ['c3', 'CA 702-118', 7], ['c4', 'CL 63-005', 5], ['c5', 'CY 31-447', 3], ['c6', 'CL 88-312', 5], ['c7', 'CAW 5-190', 5], ['c8', 'CL 27-940', 4], ['c9', 'CA 455-617', 5]].map(([id, plate, cap]) => ({ id, plate, cap }));
  const M = [['m1', 'Thabo', 'c1', .75, 1], ['m2', 'Lize', 'c2', .7, 1], ['m3', 'Kobus', 'c3', .8, 1.9], ['m4', 'Anri', 'c3', .8, 1.1], ['m5', 'Sipho', 'c4', .6, 1], ['m6', 'Meg', 'c5', .7, 1.2], ['m7', 'Ravi', 'c6', .55, .9], ['m8', 'Pieter', 'c7', .75, .2], ['m9', 'Jacques', 'c8', .5, 1], ['m10', 'Aisha', 'c9', .65, 1], ['m11', 'Nandi', null, .75, 0], ['m12', 'Chloé', null, .6, 0], ['m13', 'Tumi', null, .55, 0], ['m14', 'Sam', null, .5, 0]];
  const joined = ymd(addDays(today, -60)), cap = id => cars.find(c => c.id === id).cap;
  const members = M.map(m => ({ id: m[0], nick: m[1], carId: m[2], joined, pinHash: null }));
  const trips = []; let tid = 1;
  for (let back = 42; back >= 1; back--) {
    const d = addDays(today, -back), wd = d.getDay(); if (wd !== 2 && wd !== 4) continue; const ds = ymd(d);
    const att = M.filter(m => { if (m[1] === 'Jacques' && back < 32) return false; if (m[1] === 'Sam' && back < 38) return false; return r() < m[3]; });
    const owners = att.filter(m => m[2]).map(m => ({ m, s: m[4] * (.3 + r()) })).sort((a, b) => b.s - a.s);
    const used = new Set(), drivers = [];
    for (const o of owners) { const seats = drivers.reduce((s, x) => s + cap(x[2]) - 1, 0); if (drivers.length && seats >= att.length - drivers.length) break; if (used.has(o.m[2]) || o.s < .08) continue; used.add(o.m[2]); drivers.push(o.m); }
    const riders = att.filter(m => !drivers.includes(m)).sort(() => r() - .5), base = cutoff(ds) - 6 * 3600e3;
    drivers.forEach(dv => {
      const t = { id: 't' + tid++, date: ds, driverId: dv[0], dir: 'both', seats: cap(dv[2]) - 1, riders: [], created: base };
      while (t.riders.length < t.seats && riders.length) { const rm = riders.shift(); t.riders.push({ id: rm[0], ts: base + t.riders.length * 6e4, prio: true, dir: r() < .08 ? 'in' : 'both' }); }
      trips.push(t);
    });
  }
  // upcoming lifts on the next two office days, including one that's oversubscribed
  const up = []; for (let k = 0; up.length < 2 && k < 14; k++) { const d = addDays(today, k); if (d.getDay() === 2 || d.getDay() === 4) up.push(ymd(d)); }
  const now = Date.now(), mk = (date, driverId, seats, riders) => trips.push({ id: 't' + tid++, date, driverId, dir: 'both', seats, created: now - 5 * 3600e3 + tid,
    riders: riders.map(([id, prio, dir], i) => ({ id, prio, dir: dir || 'both', ts: now - 4 * 3600e3 + i * 6e5 })) });
  mk(up[0], 'm3', 6, [['m4', true], ['m11', false], ['m13', false]]);
  mk(up[0], 'm6', 2, [['m10', true], ['m7', true, 'in']]);
  mk(up[1], 'm1', 4, [['m2', true], ['m12', false], ['m11', false], ['m5', true], ['m4', true], ['m13', false]]);
  return { group: { name: 'Deep South Lift Club' }, members, cars, trips, log: [] };
}

/* ---------- boot ---------- */
(async function boot() {
  const cfg = window.FIREBASE_CONFIG;
  const configured = cfg && cfg.projectId && !/PASTE/.test(cfg.projectId) && typeof firebase !== 'undefined';
  if (DEMO) store = memoryStore(demoSeed());
  else if (configured) { try { store = firebaseStore(); } catch (e) { loadErr = 'Firebase didn\'t start. Check the settings in firebase-config.js.'; } }
  render();
  if (!store) return;
  try { await store.ready; } catch (e) { console.error(e); loadErr = 'Couldn\'t sign in to Firebase. Check that Anonymous sign-in is turned on (SETUP.md, step 4).'; render(); return; }
  if (!GID) { render(); return; }
  if (!DEMO) ls.set('dslc:last', GID);
  const savedMe = ls.get(meKey());
  store.watch(GID, st => {
    const meId = S ? S.meId : savedMe;
    S = { ...st, meId };
    const ae = document.activeElement; if (!(ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT'))) render();
  }, e => { console.error(e); loadErr = e && e.code === 'permission-denied' ? 'Firebase refused access. Check the security rules were published (SETUP.md, step 5).' : 'Lost the connection to the lift club. Reload the page to try again.'; render(); });
  setInterval(() => { if (ymd(new Date()) !== TODAY) render(); }, 60000);
})();

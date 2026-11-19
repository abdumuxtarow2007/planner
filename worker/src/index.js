/* ASMO — Telegram-бот на Cloudflare Workers.
   Принимает сообщения от Telegram (webhook) и раз в минуту шлёт напоминания и утреннюю сводку.
   Данные берёт из тех же таблиц Supabase, что и сайт: planner_data (задачи) и planner_bot (настройки бота). */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/hemis/')) return hemisRoute(req, env, url);
    const m = url.pathname.match(/^\/hook\/([0-9a-f-]{36})$/i);
    if (m && req.method === 'POST') return hook(req, env, m[1]);
    if (url.pathname === '/hook' && req.method === 'POST') return sharedHook(req, env);
    if (url.pathname === '/info') return new Response(JSON.stringify({ shared: !!(env.BOT_TOKEN && env.HOOK_SECRET), bot: env.BOT_USERNAME || '' }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
    if (url.pathname === '/setup') return setup(url, env);
    if (url.pathname === '/health') {
      try { await sb(env, 'planner_bot?select=user_id&limit=1'); return new Response('supabase: ok'); }
      catch (e) { return new Response('supabase: ' + String(e && e.message).slice(0, 300), { status: 500 }); }
    }
    return new Response('ASMO bot: ok', { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
};

/* ---------------- Supabase ---------------- */
function sbHeaders(env, extra = {}) {
  const k = env.SUPABASE_SERVICE_KEY;
  const h = { apikey: k, 'Content-Type': 'application/json', ...extra };
  if (!String(k).startsWith('sb_')) h.Authorization = 'Bearer ' + k;
  return h;
}
async function sb(env, path, opt = {}) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, { ...opt, headers: sbHeaders(env, opt.headers) });
  if (!r.ok) throw new Error('supabase ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}
const getBot = async (env, uid) => (await sb(env, `planner_bot?user_id=eq.${uid}&select=*`))[0] || null;
const patchBot = (env, uid, body) =>
  sb(env, `planner_bot?user_id=eq.${uid}`, { method: 'PATCH', body: JSON.stringify({ ...body, updated_at: new Date().toISOString() }) });

const dataOf = o => ({ tasks: o.tasks || [], plans: o.plans || [], routine: o.routine || [], exp: o.exp || [], rx: o.rx || [], rdone: o.rdone || {}, del: o.del || {}, rdu: o.rdu || {} });
async function loadData(env, uid) {
  const row = (await sb(env, `planner_data?user_id=eq.${uid}&select=data,updated_at`))[0];
  return { data: dataOf((row && row.data) || {}), at: row ? row.updated_at : null, raw: row ? row.data || {} : null };
}
/* Изменяет данные пользователя. fn(data) возвращает результат и помечает изменения через data._ch = true.
   Запись условная (по updated_at), чтобы не затереть правку, которую сайт сохранил в ту же секунду. */
async function withData(env, uid, fn) {
  for (let i = 0; i < 4; i++) {
    const { data, at, raw } = await loadData(env, uid);
    const res = fn(data);
    if (!data._ch) return res;
    delete data._ch;
    const body = { data: { ...(raw || {}), ...data }, updated_at: new Date().toISOString() };
    if (at === null) {
      await sb(env, 'planner_data', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ user_id: uid, ...body }) });
      return res;
    }
    const saved = await sb(env, `planner_data?user_id=eq.${uid}&updated_at=eq.${encodeURIComponent(at)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body),
    });
    if (saved && saved.length) return res;
  }
  throw new Error('planner_data: не удалось сохранить после повторов');
}
const touch = (data, it) => { it.u = Date.now(); data._ch = true; };
const remove = (data, id) => { data.tasks = data.tasks.filter(t => t.id !== id); data.del[id] = Date.now(); data._ch = true; };

/* ---------------- время и даты ---------------- */
function nowIn(tz) {
  let p;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date()).map(x => [x.type, x.value]));
  } catch (e) { return nowIn('Asia/Tashkent'); }
  const h = +p.hour % 24, mi = +p.minute;
  return { date: `${p.year}-${p.month}-${p.day}`, year: +p.year, mins: h * 60 + mi, hm: String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0') };
}
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const dow = s => (parse(s).getUTCDay() + 6) % 7 + 1;
const MON = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const WDF = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/* ---------------- Telegram ---------------- */
async function tg(token, method, params = {}) {
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) { const e = new Error(j.description || 'Telegram error'); e.code = j.error_code; throw e; }
  return j.result;
}

const HELP = `Напишите мне задачу — добавлю её в планировщик на сегодня.

<b>Примеры</b>
• Позвонить поставщику
• завтра 14:30 Созвон с командой
• 20.11 Сдать отчёт
• ! Подписать акт — с высокой важностью
Вторая строка сообщения станет заметкой.

<b>Команды</b>
/today — задачи на сегодня
/tomorrow — на завтра
/week — ближайшие 7 дней
/overdue — просроченные
/plans — планы
/done — выполнено сегодня
/schedule — график дня`;

/* Контекст одного пользователя: бот, текущее время в его часовом поясе и помощники форматирования */
function makeCtx(env, bot) {
  const n = nowIn(bot.tz);
  const c = {
    env, bot, uid: bot.user_id, t: n.date, year: n.year, mins: n.mins, hm: n.hm,
    fmt: s => { const d = parse(s); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + (d.getUTCFullYear() !== n.year ? ' ' + d.getUTCFullYear() : ''); },
    send: (text, kb) => tg(tok(env, bot), 'sendMessage', { chat_id: bot.chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) }),
  };
  c.fmtLong = s => WDF[parse(s).getUTCDay()] + ', ' + c.fmt(s);
  c.when = x => c.fmt(x.date) + (x.time ? ', ' + x.time : '');
  return c;
}

const sortT = (a, b) => (a.done - b.done) || ((a.time || '99:99').localeCompare(b.time || '99:99')) || (a.prio - b.prio) || ((a.created || 0) - (b.created || 0));
const dayTasks = (D, d) => D.tasks.filter(t => t.date === d);
const dayRoutine = (D, d) => {
  const ov = (D.rx || []).filter(x => x.date === d), out = [];
  for (const r of D.routine) {
    if (!(r.days || []).includes(dow(d))) continue;
    const o = ov.find(x => x.rid === r.id);
    if (o && o.kind === 'skip') continue;
    out.push(o && o.kind === 'edit' ? { ...r, title: o.title, start: o.start, end: o.end || '', note: o.note || '' } : r);
  }
  ov.filter(x => x.kind === 'add').forEach(x => out.push({ id: x.id, title: x.title, start: x.start, end: x.end || '', note: x.note || '' }));
  return out.sort((a, b) => a.start.localeCompare(b.start));
};
const rIsDone = (D, id, d) => (D.rdone[d] || []).includes(id);
const planPct = p => (p.steps.length ? Math.round(p.steps.filter(s => s.done).length / p.steps.length * 100) : 0);

function agendaText(c, D, d) {
  const a = dayRoutine(D, d).map(r => ({ kind: 'r', start: r.start, end: r.end || '', title: r.title, done: rIsDone(D, r.id, d) }))
    .concat(dayTasks(D, d).filter(t => t.time).map(t => ({ kind: 't', start: t.time, end: '', title: t.title, done: t.done })))
    .concat((D.hemis || []).filter(l => l.date === d).map(l => ({ kind: 'h', start: l.start, end: l.end, title: l.title + (l.room ? ', ауд. ' + l.room : ''), done: false })))
    .sort((x, y) => x.start.localeCompare(y.start));
  if (!a.length) return '';
  return `<b>График на ${esc(d === c.t ? 'сегодня' : c.fmt(d))}</b>\n\n` +
    a.map(x => (x.done ? '✅ ' : '🕒 ') + x.start + (x.end ? '–' + x.end : '') + ' ' + esc(x.title) + (x.kind === 't' ? ' <i>(задача)</i>' : x.kind === 'h' ? ' <i>(пара)</i>' : '')).join('\n');
}

function taskKb(t) {
  return t.done ? [[{ text: '↩ Вернуть в работу', callback_data: 't|' + t.id + '|u' }]]
    : [[{ text: '✓ Выполнено', callback_data: 't|' + t.id + '|d' }, { text: '→ На завтра', callback_data: 't|' + t.id + '|m' }], [{ text: 'Удалить', callback_data: 't|' + t.id + '|x' }]];
}

function list(c, D, key) {
  const t = c.t, od = key === 'od';
  const items = od ? D.tasks.filter(x => !x.done && x.date < t).sort((a, b) => a.date.localeCompare(b.date)) : dayTasks(D, key).sort(sortT);
  const head = od ? 'Просроченные' : (key === t ? 'Сегодня, ' + c.fmt(key) : key === addDays(t, 1) ? 'Завтра, ' + c.fmt(key) : c.fmtLong(key));
  if (!items.length) return { text: `<b>${esc(head)}</b>\n\n${od ? 'Просроченных задач нет.' : 'Задач нет. Напишите мне текст — добавлю задачу.'}`, kb: null };
  const lines = items.map(x => x.done ? '✅ <s>' + esc(x.title) + '</s>'
    : '▫️ ' + (x.time ? x.time + ' ' : '') + esc(x.title) + (x.prio === 1 ? ' ❗' : '') + (od ? ' <i>(' + esc(c.fmt(x.date)) + ')</i>' : ''));
  const open = items.filter(x => !x.done);
  let text = `<b>${esc(head)}</b>\n\n${lines.join('\n')}`;
  if (!od) text += `\n\nВыполнено ${items.length - open.length} из ${items.length}`;
  if (open.length) text += '\nНажмите на задачу, чтобы отметить её выполненной.';
  return { text, kb: open.length ? open.slice(0, 20).map(x => [{ text: '✓ ' + cut(x.title, 38), callback_data: 'l|' + key + '|' + x.id }]) : null };
}

function parseTask(c, text) {
  const lines = text.split('\n');
  let s = lines[0].trim(), date = c.t, time = '', prio = 2, m;
  if (/^!+/.test(s)) { prio = 1; s = s.replace(/^!+\s*/, ''); }
  if ((m = s.match(/^(сегодня|завтра|послезавтра)[\s,:]+/i))) { date = addDays(c.t, { 'сегодня': 0, 'завтра': 1, 'послезавтра': 2 }[m[1].toLowerCase()]); s = s.slice(m[0].length); }
  else if ((m = s.match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?[\s,:]+/))) {
    const dd = +m[1], mm = +m[2]; const y = m[3] ? +m[3] : c.year;
    let d = new Date(Date.UTC(y, mm - 1, dd));
    if (d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd) {
      if (!m[3] && iso(d) < c.t) d = new Date(Date.UTC(y + 1, mm - 1, dd));
      date = iso(d); s = s.slice(m[0].length);
    }
  }
  if ((m = s.match(/^(?:в\s+)?([01]?\d|2[0-3]):([0-5]\d)[\s,]+/i))) { time = m[1].padStart(2, '0') + ':' + m[2]; s = s.slice(m[0].length); }
  if (/^!+/.test(s)) { prio = 1; s = s.replace(/^!+\s*/, ''); }
  return { title: s.trim(), date, time, prio, note: lines.slice(1).join(' ').trim() };
}

/* ---------------- webhook ---------------- */
async function hook(req, env, userId) {
  let bot;
  try { bot = await getBot(env, userId); }
  catch (e) { console.error('getBot', e && e.message); return new Response('db error', { status: 500 }); }
  if (!bot ||req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== bot.hook_secret) return new Response('forbidden', { status: 403 });
  const u = await req.json().catch(() => null);
  if (u) {
    try {
      if (u.callback_query) await onCallback(env, bot, u.callback_query);
      else if (u.message && u.message.text) await onMessage(env, bot, u.message);
    } catch (e) { console.error('hook', e && e.stack || e); }
  }
  return new Response('ok');
}

/* ---------------- общий бот: один бот на всех пользователей ----------------
   Токен общего бота лежит в секрете BOT_TOKEN. Пользователь привязывает свой Telegram одноразовым кодом
   (ссылка t.me/<бот>?start=<код>), строка planner_bot у него остаётся без собственного токена (token = ''). */
const tok = (env, bot) => bot.token || env.BOT_TOKEN;

async function sharedHook(req, env) {
  if (!env.BOT_TOKEN || !env.HOOK_SECRET || req.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.HOOK_SECRET) return new Response('forbidden', { status: 403 });
  const u = await req.json().catch(() => null);
  if (!u) return new Response('ok');
  try {
    const m = u.message, q = u.callback_query;
    const chat = m ? m.chat.id : (q && q.message ? q.message.chat.id : null);
    if (chat === null) return new Response('ok');
    const rows = await sb(env, 'planner_bot?chat=eq.' + chat + '&token=eq.&select=*');
    const bot = rows && rows[0];
    if (bot) {
      if (q) await onCallback(env, bot, q);
      else if (m.text) await onMessage(env, bot, m);
    } else if (m && m.text) await linkChat(env, m);
    else if (q) await tg(env.BOT_TOKEN, 'answerCallbackQuery', { callback_query_id: q.id, text: 'Недоступно' }).catch(() => {});
  } catch (e) { console.error('sharedHook', e && e.stack || e); }
  return new Response('ok');
}

async function linkChat(env, m) {
  const say = text => tg(env.BOT_TOKEN, 'sendMessage', { chat_id: m.chat.id, text, parse_mode: 'HTML', disable_web_page_preview: true });
  const code = m.text.trim().replace(/^\/start\s*/i, '').trim();
  if (m.chat.type !== 'private' || !/^[A-Za-z0-9_-]{6,32}$/.test(code)) {
    return say('Я личный помощник планировщика ASMO. Откройте планировщик, раздел «Бот», нажмите «Подключить Telegram» и вернитесь сюда по кнопке.');
  }
  const rows = await sb(env, 'planner_bot?code=eq.' + encodeURIComponent(code) + '&chat=is.null&token=eq.&select=user_id');
  if (!rows || !rows[0]) return say('Этот код не подошёл или уже использован. Откройте раздел «Бот» в планировщике и получите новый.');
  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ');
  await patchBot(env, rows[0].user_id, { chat: m.chat.id, chat_name: name, code: null });
  await say('Готово, Telegram привязан к вашему планировщику.\n\n' + HELP);
}

/* Одноразовая настройка: откройте /setup?key=<HOOK_SECRET> — бот сам зарегистрирует webhook и команды */
async function setup(url, env) {
  if (!env.BOT_TOKEN || !env.HOOK_SECRET || url.searchParams.get('key') !== env.HOOK_SECRET) return new Response('forbidden', { status: 403 });
  try {
    const me = await tg(env.BOT_TOKEN, 'getMe');
    await tg(env.BOT_TOKEN, 'setWebhook', { url: url.origin + '/hook', secret_token: env.HOOK_SECRET, allowed_updates: ['message', 'callback_query'] });
    await tg(env.BOT_TOKEN, 'setMyCommands', { commands: [
      ['today', 'Задачи на сегодня'], ['schedule', 'График дня'], ['tomorrow', 'Задачи на завтра'], ['week', 'Ближайшие 7 дней'],
      ['overdue', 'Просроченные'], ['plans', 'Планы'], ['done', 'Выполнено сегодня'], ['help', 'Что умеет бот'],
    ].map(([command, description]) => ({ command, description })) });
    const hint = env.BOT_USERNAME === me.username ? '' : '\nЗадайте переменную BOT_USERNAME = ' + me.username;
    return new Response('ok: @' + me.username + hint, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
  } catch (e) { return new Response('error: ' + e.message, { status: 500 }); }
}

async function onMessage(env, bot, m) {
  const chat = m.chat.id, text = m.text.trim();
  if (!bot.chat) {
    if (m.chat.type === 'private' && bot.code && text.replace(/^\/start\s*/, '') === bot.code) {
      const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ');
      await patchBot(env, bot.user_id, { chat, chat_name: name, code: null });
      bot.chat = chat;
      await makeCtx(env, bot).send('Готово, бот привязан к вашему планировщику.\n\n' + HELP);
    } else {
      await tg(tok(env, bot), 'sendMessage', { chat_id: chat, text: 'Бот ещё не привязан. Откройте планировщик, раздел «Бот», и отправьте сюда код привязки.' });
    }
    return;
  }
  if (chat !== Number(bot.chat)) { await tg(tok(env, bot), 'sendMessage', { chat_id: chat, text: 'Это личный бот, он отвечает только владельцу.' }); return; }

  const c = makeCtx(env, bot), t = c.t;
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  const read = async () => { const D = (await loadData(env, c.uid)).data; D.hemis = await hemisLessons(env, c.uid).catch(() => []); return D; };
  const sendList = async key => { const l = list(c, await read(), key); await c.send(l.text, l.kb); };

  if (cmd === '/start' || cmd === '/help') return c.send(HELP);
  if (cmd === '/today' || /^сегодня$/i.test(text)) return sendList(t);
  if (cmd === '/tomorrow' || /^завтра$/i.test(text)) return sendList(addDays(t, 1));
  if (cmd === '/overdue') return sendList('od');
  if (cmd === '/schedule' || /^график$/i.test(text)) return c.send(agendaText(c, await read(), t) || 'На сегодня графика нет. Его можно настроить в планировщике, в разделе «График».');
  if (cmd === '/week') {
    const D = await read(), out = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(t, i), l = dayTasks(D, d).filter(x => !x.done).sort(sortT);
      if (l.length) out.push(`<b>${esc(c.fmtLong(d))}</b>\n` + l.map(x => '▫️ ' + (x.time ? x.time + ' ' : '') + esc(x.title) + (x.prio === 1 ? ' ❗' : '')).join('\n'));
    }
    return c.send(out.length ? out.join('\n\n') : 'На ближайшие 7 дней открытых задач нет.');
  }
  if (cmd === '/plans') {
    const D = await read();
    return c.send(D.plans.length ? D.plans.map(p => `<b>${esc(p.title)}</b> — ${planPct(p)}%\n` + p.steps.map(s => (s.done ? '✅ ' : '▫️ ') + esc(s.text)).join('\n')).join('\n\n') : 'Планов пока нет. Их можно создать в планировщике.');
  }
  if (cmd === '/done') {
    const l = (await read()).tasks.filter(x => x.done && (x.doneAt || x.date) === t);
    return c.send(l.length ? '<b>Выполнено сегодня</b>\n\n' + l.map(x => '✅ ' + esc(x.title)).join('\n') : 'Сегодня пока ничего не выполнено.');
  }
  if (cmd.startsWith('/')) return c.send('Не знаю такой команды. Отправьте /help — покажу, что я умею.');

  const p = parseTask(c, text);
  if (!p.title) return c.send('Не вижу текста задачи. Пример: «завтра 14:30 Созвон с командой».');
  const task = { id: uid(), done: false, created: Date.now(), ...p };
  await withData(env, c.uid, D => { const x = { ...task }; D.tasks.push(x); touch(D, x); });
  return c.send(`Добавлено на ${esc(c.when(task))}:\n<b>${esc(task.title)}</b>` + (task.note ? '\n' + esc(task.note) : ''), taskKb(task));
}

async function onCallback(env, bot, q) {
  const ack = text => tg(tok(env, bot), 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});
  if (!q.message || q.message.chat.id !== Number(bot.chat)) return ack('Недоступно');
  const c = makeCtx(env, bot), t = c.t;
  const [k, a, b] = String(q.data || '').split('|');
  const edit = (text, kb) => tg(tok(env, bot), 'editMessageText', { chat_id: bot.chat, message_id: q.message.message_id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb || [] } }).catch(() => {});

  if (k === 'l') {
    let found = false, D;
    await withData(env, c.uid, data => {
      D = data; const x = data.tasks.find(y => y.id === b); found = !!x;
      if (x && !x.done) { x.done = true; x.doneAt = t; touch(data, x); }
    });
    const l = list(c, D, a); await edit(l.text, l.kb);
    return ack(found ? 'Выполнено' : 'Задача уже удалена');
  }
  if (k === 't') {
    const x = await withData(env, c.uid, D => {
      const x = D.tasks.find(y => y.id === a);
      if (!x) return null;
      if (b === 'd') { x.done = true; x.doneAt = t; touch(D, x); }
      else if (b === 'u') { x.done = false; x.doneAt = null; touch(D, x); }
      else if (b === 'm') { x.prevDate = x.date; x.date = addDays(x.date < t ? t : x.date, 1); touch(D, x); }
      else if (b === 'b') { if (x.prevDate) { const d = x.date; x.date = x.prevDate; x.prevDate = d; touch(D, x); } }
      else if (b === 'x') remove(D, a);
      return { ...x };
    });
    if (!x) { await edit('Этой задачи уже нет в планировщике.'); return ack('Задача не найдена'); }
    const name = `<b>${esc(x.title)}</b>`;
    if (b === 'd') { await edit('✅ Выполнено: ' + name, taskKb(x)); return ack('Выполнено'); }
    if (b === 'u') { await edit(`В работе, ${esc(c.when(x))}:\n` + name, taskKb(x)); return ack('Возвращено в работу'); }
    if (b === 'm') {
      await edit(`Перенесено на ${esc(c.fmt(x.date))}:\n` + name, [[{ text: '↩ Вернуть на ' + c.fmt(x.prevDate), callback_data: 't|' + x.id + '|b' }], [{ text: '✓ Выполнено', callback_data: 't|' + x.id + '|d' }]]);
      return ack('Перенесено');
    }
    if (b === 'b') { await edit(`Возвращено на ${esc(c.when(x))}:\n` + name, taskKb(x)); return ack('Возвращено'); }
    if (b === 'x') { await edit('Удалено: ' + esc(x.title)); return ack('Удалено'); }
  }
  return ack();
}

/* ---------------- раз в минуту: сводка и напоминания ---------------- */
async function tick(env) {
  await hemisTick(env).catch(e => console.error('hemisTick', e && e.message));
  const bots = await sb(env, 'planner_bot?chat=not.is.null&select=*');
  await Promise.allSettled((bots || []).map(b => tickOne(env, b).catch(e => console.error('tick', b.user_id, e && e.message))));
}

async function tickOne(env, bot) {
  const c = makeCtx(env, bot), t = c.t;
  const needDigest = bot.digest && bot.last_digest !== t && c.hm >= bot.digest_time;
  if (!needDigest && !bot.remind) return;
  const D = (await loadData(env, c.uid)).data;
  D.hemis = await hemisLessons(env, c.uid).catch(() => []);
  const sent = { ...(bot.sent || {}) }, patch = {};
  const out = [];

  if (needDigest) {
    patch.last_digest = t;
    const l = list(c, D, t), od = D.tasks.filter(x => !x.done && x.date < t).length, ag = agendaText(c, D, t);
    out.push(['Доброе утро! План на день.\n\n' + (ag ? ag + '\n\n' : '') + l.text + (od ? `\n\nПросроченных задач: ${od}. Посмотреть: /overdue` : ''), l.kb]);
  }
  if (bot.remind) {
    for (const x of dayTasks(D, t)) {
      if (x.done || !x.time) continue;
      const key = x.id + '|' + x.date + '|' + x.time, [h, m] = x.time.split(':').map(Number), diff = c.mins - (h * 60 + m);
      if (diff < 0 || sent[key]) continue;
      sent[key] = 1;
      if (diff <= 30) out.push([`⏰ ${esc(x.time)} — <b>${esc(x.title)}</b>` + (x.note ? '\n' + esc(x.note) : ''), taskKb(x)]);
    }
    for (const r of dayRoutine(D, t)) {
      const key = 'r:' + r.id + '|' + t + '|' + r.start, [h, m] = r.start.split(':').map(Number), diff = c.mins - (h * 60 + m);
      if (diff < 0 || sent[key]) continue;
      sent[key] = 1;
      if (diff <= 30 && !rIsDone(D, r.id, t)) out.push([`🕒 ${esc(r.start)}${r.end ? '–' + esc(r.end) : ''} по графику: <b>${esc(r.title)}</b>` + (r.note ? '\n' + esc(r.note) : '')]);
    }
    /* пары из HEMIS: напоминаем за 15 минут до начала */
    for (const l of D.hemis.filter(l => l.date === t)) {
      const key = 'h:' + l.id + '|' + t + '|' + l.start, [h, m] = l.start.split(':').map(Number), diff = c.mins - (h * 60 + m - 15);
      if (diff < 0 || sent[key]) continue;
      sent[key] = 1;
      if (diff <= 30) out.push([`🎓 ${esc(l.start)}–${esc(l.end)} пара: <b>${esc(l.title)}</b>` + [l.type, l.room && 'ауд. ' + l.room, l.teacher].filter(Boolean).map(x => '\n' + esc(x)).join('')]);
    }
    for (const k in sent) if (!k.includes('|' + t + '|')) delete sent[k];
    if (JSON.stringify(sent) !== JSON.stringify(bot.sent || {})) patch.sent = sent;
  }
  /* сначала запоминаем отправленное, потом отправляем — так при сбое не будет дублей */
  if (Object.keys(patch).length) await patchBot(env, c.uid, patch);
  for (const [text, kb] of out) {
    try { await c.send(text, kb); }
    catch (e) { if (e.code === 403 || e.code === 401) { console.warn('bot blocked/invalid', c.uid, e.message); break; } throw e; }
  }
}


/* ---------------- HEMIS: расписание пар ----------------
   Сайт присылает логин и пароль HEMIS один раз (POST /hemis/connect). Воркер входит в студенческий портал вуза,
   забирает пары на ближайшие недели и хранит их в таблице planner_hemis. Дальше раз в 6 часов обновляет сам.
   Пароль хранится только в зашифрованном виде (секрет HEMIS_KEY) и только если пользователь разрешил —
   он нужен, чтобы заново войти, когда токен HEMIS истечёт. */
const HEMIS_EVERY = 6 * 3600e3;
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS' };
const jres = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors } });

async function hemisRoute(req, env, url) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return jres({ error: 'method' }, 405);
  /* кто спрашивает: проверяем токен сессии Supabase */
  const jwt = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const ur = jwt ? await fetch(env.SUPABASE_URL + '/auth/v1/user', { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: 'Bearer ' + jwt } }) : null;
  if (!ur || !ur.ok) return jres({ error: 'Войдите в аккаунт ASMO заново.' }, 401);
  const userId = (await ur.json()).id;
  const body = await req.json().catch(() => ({}));
  try {
    if (url.pathname === '/hemis/connect') {
      const base = hemisBase(body.base), login = String(body.login || '').trim(), password = String(body.password || '');
      if (!base) return jres({ error: 'Адрес портала должен быть вида https://student.<вуз>.uz' }, 400);
      if (!login || !password) return jres({ error: 'Введите логин и пароль HEMIS.' }, 400);
      const token = await hemisLogin(base, login, password);
      const lessons = await hemisFetch(base, token);
      const pass = body.remember && env.HEMIS_KEY ? await seal(env, password) : '';
      await sb(env, 'planner_hemis?on_conflict=user_id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify({ user_id: userId, base, login, token, pass, lessons, synced_at: new Date().toISOString(), error: '' }) });
      return jres({ ok: true, count: lessons.length, remember: !!pass });
    }
    if (url.pathname === '/hemis/sync') {
      const row = (await sb(env, `planner_hemis?user_id=eq.${userId}&select=*`))[0];
      if (!row) return jres({ error: 'HEMIS не подключён.' }, 404);
      const r = await hemisSyncRow(env, row);
      return r.error ? jres({ error: r.error }, 502) : jres({ ok: true, count: r.count });
    }
    if (url.pathname === '/hemis/disconnect') {
      await sb(env, `planner_hemis?user_id=eq.${userId}`, { method: 'DELETE' });
      return jres({ ok: true });
    }
    return jres({ error: 'not found' }, 404);
  } catch (e) {
    return jres({ error: e.user ? e.message : 'HEMIS не ответил: ' + String(e && e.message).slice(0, 200) }, e.user ? 400 : 502);
  }
}

/* только студенческие порталы HEMIS, чтобы воркер нельзя было использовать как прокси куда угодно */
function hemisBase(v) {
  let s = String(v || '').trim().toLowerCase();
  if (!s) return '';
  if (!/^https?:\/\//.test(s)) s = 'https://' + s;
  let u; try { u = new URL(s); } catch (e) { return ''; }
  return /^student\.([a-z0-9-]+\.)*[a-z0-9-]+\.uz$/.test(u.hostname) ? 'https://' + u.hostname : '';
}
const uerr = m => Object.assign(new Error(m), { user: true });

async function hemisJson(base, path, opt = {}) {
  const r = await fetch(base + '/rest/v1/' + path, { ...opt, headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(opt.headers || {}) } });
  const j = await r.json().catch(() => null);
  if (r.status === 401 || r.status === 403) throw Object.assign(new Error('unauthorized'), { auth: true });
  if (!r.ok || !j) throw new Error(path + ': HTTP ' + r.status);
  if (j.success === false) throw new Error(path + ': ' + (j.error || j.message || 'ошибка'));
  return j;
}
async function hemisLogin(base, login, password) {
  let j;
  try { j = await hemisJson(base, 'auth/login', { method: 'POST', body: JSON.stringify({ login, password }) }); }
  catch (e) { if (e.auth || /auth\/login: /.test(e.message)) throw uerr('HEMIS не принял логин или пароль.'); throw e; }
  const t = (j.data && (j.data.token || j.data.access_token)) || j.token;
  if (!t) throw uerr('HEMIS не выдал токен. Проверьте логин и пароль.');
  return String(t).replace(/^Bearer\s+/i, '');
}

/* пары текущей и двух следующих недель (плюс прошедшая — чтобы день назад тоже был виден) */
async function hemisFetch(base, token) {
  const H = { headers: { Authorization: 'Bearer ' + token } };
  const now = Date.now() / 1000, rows = [];
  let weeks = [], sem = '';
  try {
    const s = await hemisJson(base, 'education/semesters', H);
    const list = Array.isArray(s.data) ? s.data : [];
    const cur = list.find(x => x.current) || list[list.length - 1];
    if (cur) {
      sem = cur.code;
      weeks = (cur.weeks || []).filter(w => w.end_date >= now - 7 * 86400 && w.start_date <= now + 21 * 86400).sort((a, b) => a.start_date - b.start_date).slice(0, 4);
    }
  } catch (e) { if (e.auth) throw e; }
  if (weeks.length) {
    for (const w of weeks) {
      const j = await hemisJson(base, `education/schedule?semester=${encodeURIComponent(sem)}&week=${encodeURIComponent(w.id)}`, H);
      rows.push(...(Array.isArray(j.data) ? j.data : []));
    }
  } else {
    const j = await hemisJson(base, 'education/schedule', H);
    rows.push(...(Array.isArray(j.data) ? j.data : []));
  }
  return normLessons(rows);
}

const nm = v => (v && typeof v === 'object' ? v.name || v.title || '' : v || '').toString().trim();
const hhmm = v => { const m = String(v || '').match(/^(\d{1,2}):(\d{2})/); return m ? m[1].padStart(2, '0') + ':' + m[2] : ''; };
function tashDate(sec) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(sec * 1000));
}
function normLessons(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!r || !r.lesson_date) continue;
    const p = r.lessonPair || {};
    const l = {
      date: tashDate(Number(r.lesson_date)), start: hhmm(p.start_time), end: hhmm(p.end_time),
      title: nm(r.subject) || 'Занятие', type: nm(r.trainingType), room: nm(r.auditorium), teacher: nm(r.employee),
    };
    if (!l.start) continue;
    l.id = 'h' + hash32([l.date, l.start, l.title, l.type, l.room].join('|'));
    out.set(l.id, l);
  }
  return [...out.values()].sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}
function hash32(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); }

async function hemisSyncRow(env, row) {
  let token = row.token, patch;
  try {
    let lessons;
    try { lessons = await hemisFetch(row.base, token); }
    catch (e) {
      if (!e.auth) throw e;
      /* токен истёк — входим заново, если пароль сохранён */
      if (!row.pass || !env.HEMIS_KEY) throw uerr('Сессия HEMIS истекла. Войдите в HEMIS заново в разделе «График».');
      token = await hemisLogin(row.base, row.login, await unseal(env, row.pass));
      lessons = await hemisFetch(row.base, token);
    }
    patch = { token, lessons, synced_at: new Date().toISOString(), error: '' };
  } catch (e) {
    patch = { synced_at: new Date().toISOString(), error: e.user ? e.message : 'Не удалось обновить: ' + String(e.message).slice(0, 150) };
  }
  await sb(env, `planner_hemis?user_id=eq.${row.user_id}`, { method: 'PATCH', body: JSON.stringify(patch) });
  return patch.error ? { error: patch.error } : { count: patch.lessons.length };
}

async function hemisTick(env) {
  const since = new Date(Date.now() - HEMIS_EVERY).toISOString();
  const rows = await sb(env, `planner_hemis?synced_at=lt.${encodeURIComponent(since)}&select=*&limit=5`);
  for (const r of rows || []) await hemisSyncRow(env, r).catch(e => console.error('hemis sync', r.user_id, e && e.message));
}
async function hemisLessons(env, uid) {
  const row = (await sb(env, `planner_hemis?user_id=eq.${uid}&select=lessons`))[0];
  return (row && row.lessons) || [];
}

/* шифрование пароля AES-GCM ключом из секрета HEMIS_KEY */
async function aesKey(env) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.HEMIS_KEY));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const b64 = u => btoa(String.fromCharCode(...u));
const unb64 = s => Uint8Array.from(atob(s), ch => ch.charCodeAt(0));
async function seal(env, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(env), new TextEncoder().encode(text)));
  return b64(iv) + '.' + b64(ct);
}
async function unseal(env, s) {
  const [iv, ct] = s.split('.').map(unb64);
  return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, await aesKey(env), ct));
}

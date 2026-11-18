/* ASMO — Telegram-бот на Cloudflare Workers.
   Принимает сообщения от Telegram (webhook) и раз в минуту шлёт напоминания и утреннюю сводку.
   Данные берёт из тех же таблиц Supabase, что и сайт: planner_data (задачи) и planner_bot (настройки бота). */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/hook\/([0-9a-f-]{36})$/i);
    if (m && req.method === 'POST') return hook(req, env, m[1]);
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

const dataOf = o => ({ tasks: o.tasks || [], plans: o.plans || [], routine: o.routine || [], exp: o.exp || [], rdone: o.rdone || {}, del: o.del || {}, rdu: o.rdu || {} });
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
    send: (text, kb) => tg(bot.token, 'sendMessage', { chat_id: bot.chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb ? { reply_markup: { inline_keyboard: kb } } : {}) }),
  };
  c.fmtLong = s => WDF[parse(s).getUTCDay()] + ', ' + c.fmt(s);
  c.when = x => c.fmt(x.date) + (x.time ? ', ' + x.time : '');
  return c;
}

const sortT = (a, b) => (a.done - b.done) || ((a.time || '99:99').localeCompare(b.time || '99:99')) || (a.prio - b.prio) || ((a.created || 0) - (b.created || 0));
const dayTasks = (D, d) => D.tasks.filter(t => t.date === d);
const dayRoutine = (D, d) => D.routine.filter(r => (r.days || []).includes(dow(d))).sort((a, b) => a.start.localeCompare(b.start));
const rIsDone = (D, id, d) => (D.rdone[d] || []).includes(id);
const planPct = p => (p.steps.length ? Math.round(p.steps.filter(s => s.done).length / p.steps.length * 100) : 0);

function agendaText(c, D, d) {
  const a = dayRoutine(D, d).map(r => ({ kind: 'r', start: r.start, end: r.end || '', title: r.title, done: rIsDone(D, r.id, d) }))
    .concat(dayTasks(D, d).filter(t => t.time).map(t => ({ kind: 't', start: t.time, end: '', title: t.title, done: t.done })))
    .sort((x, y) => x.start.localeCompare(y.start));
  if (!a.length) return '';
  return `<b>График на ${esc(d === c.t ? 'сегодня' : c.fmt(d))}</b>\n\n` +
    a.map(x => (x.done ? '✅ ' : '🕒 ') + x.start + (x.end ? '–' + x.end : '') + ' ' + esc(x.title) + (x.kind === 't' ? ' <i>(задача)</i>' : '')).join('\n');
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

async function onMessage(env, bot, m) {
  const chat = m.chat.id, text = m.text.trim();
  if (!bot.chat) {
    if (m.chat.type === 'private' && bot.code && text.replace(/^\/start\s*/, '') === bot.code) {
      const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(' ');
      await patchBot(env, bot.user_id, { chat, chat_name: name, code: null });
      bot.chat = chat;
      await makeCtx(env, bot).send('Готово, бот привязан к вашему планировщику.\n\n' + HELP);
    } else {
      await tg(bot.token, 'sendMessage', { chat_id: chat, text: 'Бот ещё не привязан. Откройте планировщик, раздел «Бот», и отправьте сюда код привязки.' });
    }
    return;
  }
  if (chat !== Number(bot.chat)) { await tg(bot.token, 'sendMessage', { chat_id: chat, text: 'Это личный бот, он отвечает только владельцу.' }); return; }

  const c = makeCtx(env, bot), t = c.t;
  const cmd = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, '');
  const read = async () => (await loadData(env, c.uid)).data;
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
  const ack = text => tg(bot.token, 'answerCallbackQuery', { callback_query_id: q.id, ...(text ? { text } : {}) }).catch(() => {});
  if (!q.message || q.message.chat.id !== Number(bot.chat)) return ack('Недоступно');
  const c = makeCtx(env, bot), t = c.t;
  const [k, a, b] = String(q.data || '').split('|');
  const edit = (text, kb) => tg(bot.token, 'editMessageText', { chat_id: bot.chat, message_id: q.message.message_id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb || [] } }).catch(() => {});

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
  const bots = await sb(env, 'planner_bot?chat=not.is.null&select=*');
  await Promise.allSettled((bots || []).map(b => tickOne(env, b).catch(e => console.error('tick', b.user_id, e && e.message))));
}

async function tickOne(env, bot) {
  const c = makeCtx(env, bot), t = c.t;
  const needDigest = bot.digest && bot.last_digest !== t && c.hm >= bot.digest_time;
  if (!needDigest && !bot.remind) return;
  const D = (await loadData(env, c.uid)).data;
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

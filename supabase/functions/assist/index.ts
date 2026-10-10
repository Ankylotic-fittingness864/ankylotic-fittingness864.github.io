// رفيق — assist: the chat brain (Claude first, Gemini as a fallback). Understands one message in the context of a short conversation and the
// unsaved drafts: replies naturally, captures tasks / work done, edits drafts, or turns a question into a structured query.
// It never receives the user's stored tasks — only the conversation, the unsaved drafts and contact names.
// Secrets: ANTHROPIC_API_KEY (optional CLAUDE_MODEL) and/or GEMINI_API_KEY (optional GEMINI_MODEL). Either one is enough.
import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = ['https://myrafeeq.github.io', 'https://omarmostafa599-star.github.io'];
const MODELS = [Deno.env.get('GEMINI_MODEL') || 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite'];
const CLAUDE_MODEL = Deno.env.get('CLAUDE_MODEL') || 'claude-haiku-5-5';
const DAILY_CAP = 600;
const BUDGET_MS = 19000; // the app gives up after 22 s (long lists: 30 s budget, 34 s in the app)

/** The Gemini schema above, as standard JSON Schema (Claude tool input). */
function jsonSchema(g: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  const type = String(g.type).toLowerCase();
  o.type = g.nullable ? [type, 'null'] : type;
  if (g.enum) o.enum = g.nullable ? [...(g.enum as unknown[]), null] : g.enum;
  if (g.items) o.items = jsonSchema(g.items as Record<string, unknown>);
  if (g.properties) {
    o.properties = Object.fromEntries(Object.entries(g.properties as Record<string, Record<string, unknown>>).map(([k, v]) => [k, jsonSchema(v)]));
    if (g.required) o.required = g.required;
    o.additionalProperties = false;
  }
  return o;
}

/** The assigner is the source, not one of the task's people (unless the user must follow up with them). */
const bare = (v: unknown) => String(v ?? '').replace(/[\u064B-\u0652\u0640]/g, '').replace(/(^|\s)(م|د|أ|ا|مهندس|دكتور|أستاذ|استاذ)\.?\s+/g, ' ').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/\s+/g, ' ').trim();
const ME = /^(انا|نفسي|انا نفسي|me|myself|self|the user|user)$/i; // «source: أنا» means self-initiated, not a person called أنا
const sameName = (a: unknown, b: unknown) => { const x = bare(a), y = bare(b); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };

/** Whatever a model returns, hand the app the shape it expects. */
const INTENTS = ['chat', 'capture', 'log', 'edit', 'save', 'cancel', 'query', 'other'];
function tidy(r: Record<string, unknown>) {
  const arr = (v: unknown) => Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : [];
  const out: Record<string, unknown> = {
    intent: INTENTS.includes(r?.intent as string) ? r.intent : 'other',
    reply: typeof r?.reply === 'string' ? r.reply.slice(0, 600) : '',
    tasks: arr(r?.tasks).slice(0, 20).map((x: Record<string, unknown>) => (ME.test(bare(x.source)) ? { ...x, source: null, source_self: true } : x)).map((x: Record<string, unknown>) => ({ ...x, people: arr(x.people).filter((p: Record<string, unknown>) => !(p.role === 'related' && sameName(p.name, x.source))) })),
    logs: arr(r?.logs).slice(0, 20),
    edits: arr(r?.edits).slice(0, 20),
    remove: Array.isArray(r?.remove) ? r.remove.filter((n) => Number.isInteger(n)).slice(0, 10) : [],
  };
  if (r?.query && typeof r.query === 'object') out.query = r.query;
  return out;
}

function cors(req: Request) {
  const o = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(o) ? o : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}
const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'Content-Type': 'application/json' } });

const N = (o: Record<string, unknown>) => ({ ...o, nullable: true });
const RECUR = N({ type: 'OBJECT', properties: { freq: { type: 'STRING', enum: ['daily', 'weekly', 'monthly', 'quarterly'] }, days: { type: 'ARRAY', items: { type: 'INTEGER' } }, dom: N({ type: 'INTEGER' }), last: { type: 'BOOLEAN' } }, required: ['freq'] });
const PERSON = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING' }, desc: N({ type: 'STRING' }), generic: { type: 'BOOLEAN' },
    role: { type: 'STRING', enum: ['followup', 'waiting', 'related'] }, what: N({ type: 'STRING' }), due: N({ type: 'STRING' }),
  },
  required: ['name', 'role'],
};
const SCHEMA = {
  type: 'OBJECT',
  properties: {
    intent: { type: 'STRING', enum: ['chat', 'capture', 'log', 'edit', 'save', 'cancel', 'query', 'other'] },
    reply: { type: 'STRING' },
    logs: { type: 'ARRAY', items: { type: 'OBJECT', properties: { title: { type: 'STRING' }, date: N({ type: 'STRING' }), project: N({ type: 'STRING' }) }, required: ['title'] } },
    tasks: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: { type: 'STRING' }, due: N({ type: 'STRING' }), due_time: N({ type: 'STRING' }), no_due: { type: 'BOOLEAN' }, recur: RECUR,
          priority: { type: 'STRING', enum: ['hi', 'mid', 'lo'] }, role: { type: 'STRING', enum: ['exec', 'follow', 'both'] },
          source: N({ type: 'STRING' }), source_self: { type: 'BOOLEAN' }, project: N({ type: 'STRING' }),
          waiting_what: N({ type: 'STRING', enum: ['reply', 'decision', 'approval'] }), people: { type: 'ARRAY', items: PERSON },
        },
        required: ['title', 'priority', 'role', 'people'],
      },
    },
    edits: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          n: { type: 'INTEGER' }, title: N({ type: 'STRING' }), due: N({ type: 'STRING' }), no_due: N({ type: 'BOOLEAN' }), due_time: N({ type: 'STRING' }), clear_time: N({ type: 'BOOLEAN' }),
          priority: N({ type: 'STRING', enum: ['hi', 'mid', 'lo'] }), role: N({ type: 'STRING', enum: ['exec', 'follow', 'both'] }),
          source: N({ type: 'STRING' }), source_self: N({ type: 'BOOLEAN' }), project: N({ type: 'STRING' }), date: N({ type: 'STRING' }),
          recur: RECUR, clear_recur: N({ type: 'BOOLEAN' }), add_people: { type: 'ARRAY', items: PERSON }, remove_people: { type: 'ARRAY', items: { type: 'STRING' } },
        },
        required: ['n'],
      },
    },
    remove: { type: 'ARRAY', items: { type: 'INTEGER' } },
    query: N({
      type: 'OBJECT',
      properties: {
        type: { type: 'STRING', enum: ['due', 'late', 'nodue', 'waiting', 'followups', 'person', 'project', 'done', 'summary'] },
        from: N({ type: 'STRING' }), to: N({ type: 'STRING' }), person: N({ type: 'STRING' }), project: N({ type: 'STRING' }),
      },
      required: ['type'],
    }),
  },
  required: ['intent', 'reply'],
};

const CLAUDE_SCHEMA = jsonSchema(SCHEMA);

/** A ready-made calendar so the model never computes weekdays or month ends itself. */
function calendar(today: string, weekend: number[]) {
  const D = (s: string) => new Date(s + 'T12:00:00Z'), iso = (d: Date) => d.toISOString().slice(0, 10);
  const add = (s: string, n: number) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
  const isWk = (s: string) => weekend.includes(D(s).getUTCDay());
  const lastWork = (s: string) => { const d = D(s); let x = iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0, 12))); while (isWk(x)) x = add(x, -1); return x; };
  const lines: string[] = [];
  for (let i = 0; i < 15; i++) { const x = add(today, i); lines.push(`${x} ${DAYS[D(x).getUTCDay()]}${i === 0 ? ' (today)' : i === 1 ? ' (tomorrow, بكرة)' : i === 2 ? ' (بعد بكرة)' : ''}${isWk(x) ? ' [weekend]' : ''}`); }
  let nw = add(today, 1); while (D(nw).getUTCDay() !== (Math.max(...weekend) + 1) % 7) nw = add(nw, 1); while (isWk(nw)) nw = add(nw, 1);
  const lw = lastWork(today) >= today ? lastWork(today) : lastWork(add(today, 20));
  return `Calendar — use it for EVERY relative date, never compute weekdays yourself:\n${lines.join('\n')}\nNext week ("الأسبوع الجاي/القادم", "next week") starts ${nw}; when no day is named, due = ${nw} exactly. End of this month ("آخر الشهر", "نهاية الشهر", "قبل نهاية الشهر") = the last WORKDAY: ${lw}. "آخر كل شهر" = recur monthly with last = true and due ${lw}. Never put a due date on a weekend day unless the user names that exact day.`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function instructions(o: { today: string; weekday: string; lang: string; known: string[]; sources: string[]; weekend: number[] }) {
  const ar = o.lang !== 'en';
  const wk = o.weekend.map(d => DAYS[d]).join(' and ');
  const start = DAYS[[0, 1, 2, 3, 4, 5, 6].map(i => (Math.max(...o.weekend) + 1 + i) % 7).find(d => !o.weekend.includes(d)) ?? 0];
  return `You are «رفيق» (Rafeeq), a friendly assistant inside a personal work organizer used by working professionals. You chat with the user, help them capture tasks, log work they already did, change the pending drafts, and answer questions about their work. Return JSON only, following the schema.

Today is ${o.today} (${o.weekday}). Weekend: ${wk}; every other day is a workday. A weekday name = its next occurrence after today; "قبل الخميس" = due that Thursday. Dates are YYYY-MM-DD.
${calendar(o.today, o.weekend)}

reply (ALWAYS): one or two short, warm, natural sentences in the SAME language and dialect as the user's last message (Egyptian → Egyptian "تمام، فهمت"; Gulf/Saudi (أبي، باكر، وش، حقت، ما له) → Gulf "تمام، فهمت عليك"; Modern Standard Arabic → MSA; English → English). The examples below are Egyptian only to show the meaning — always switch them to the user's dialect. No emojis.
- Greetings / small talk: answer naturally and offer help (e.g. "ازيك" → "الحمد لله، أساعدك إزاي النهارده؟").
- When you capture or log items, say how many and of what kind — the number MUST equal the items you actually return (e.g. "تمام، فهمت ٣ مهام." / "تمام، دول شغلتين خلصتهم."). Nothing is saved until the user confirms, so never say سجلت/حفظت/ضفت — say فهمت/جهزت. Do NOT list them (the app shows them as cards) and do NOT ask about a missing deadline, assigner or people — the app asks those itself.
- After an edit, confirm briefly what changed.
- Off-topic questions: answer in one short sentence, then offer to help with their work.

intent:
- "chat": greetings, thanks, small talk, help ("تقدر تعمل إيه؟"). tasks/logs/edits empty.
- "capture": new work to do → tasks (a message may hold SEVERAL tasks: split them, max 20 — if there are more than 20, take the first 20 and say so in reply, asking the user to send the rest in another message; do NOT split one task whose steps belong together, e.g. "أراجع التقرير وأبعته للمدير" is ONE task).
- "log": work ALREADY DONE (past tense: عملت، خلصت، زرت، راجعت، حضرت، فحصت، قابلت…) → logs (max 20). If the same message also has future work, put that in tasks.
- New items are NEVER edits: edits only change drafts that already exist (n ≤ the number of current drafts); anything new goes in tasks/logs even when drafts are open.
- "edit": the user changes the CURRENT drafts listed in the last message (e.g. "التانية خليها الأحد", "شيل الأخيرة", "ضيف سارة في الأولى", "المصدر م. مأمون", "خليها كل أسبوع", "الساعة 10"). Use edits (n = draft number, 1-based) and remove. Never create a new draft for a change to an existing one.
- "save": the user approves saving the drafts ("تمام", "ضيفهم", "احفظ", "ok", "كده تمام").
- "cancel": the user wants to discard the drafts.
- "query": a question about their stored tasks (مهامي النهارده، هات مهام بكرة، المتأخر، مين عنده متابعات واقفة، متابعاتي مع خالد، خلصت إيه الأسبوع ده) → fill query.
A message may combine new items and edits: then use "capture"/"log" and ALSO fill edits/remove.

Each task:
- title: short, clear, ${ar ? 'formal Modern Standard Arabic (فصحى), starting with a verbal noun (مصدر) e.g. مراجعة، إرسال، متابعة، إعداد، اعتماد، زيارة' : 'English'}. Keep codes, numbers, product and proper names. Remove dates, times, recurrence words, urgency words, filler and the people's names when they are captured in people. Max 90 chars. Never invent.
- due: the deadline if stated, else null. no_due = true ONLY if the user explicitly says there is no deadline ("بدون موعد", "مالها موعد", "ما له موعد محدد", "مش محدد"). due_time: "HH:MM" (24h) if a time of day is stated ("الساعة 10" = 10:00, "3 العصر" = 15:00, "الساعة 2" in a work context = 14:00), else null.
- recur: only if the user says it repeats. freq daily (every workday) | weekly (days: 0=Sunday … 6=Saturday) | monthly (dom = day of month, or last = true for the last workday of the month) | quarterly (every 3 months, dom). Otherwise null. For a recurring task without an explicit date, set due to the first occurrence from today.
- priority: "hi" ONLY if urgency is stated in that task's own words (عاجل، ضروري، مستعجل، مهم جدًا، urgent) or once for all of them («كلهم عاجلين»); never infer it from the topic, a near deadline, a manager's name or the other tasks. "lo" if explicitly not urgent; else "mid".
- role: "exec" if the user does the work; "follow" if the user only follows up others who execute; "both" if the user executes and also follows up others.
- Waiting only («مستني رد عدنان»، «بانتظار اعتماد المدير»، «منتظر نتيجة المختبر») with no work of the user's own: role = "follow", that person's role = "waiting" (NOT "followup"), waiting_what = reply / decision / approval.
- source: who assigned the task, ONLY if stated (e.g. "طلب مني م. مأمون", "المدير كلفني"). source = the person's NAME only when a name is given, without job titles or role words ("المدير عدنان الصلاح" → "عدنان الصلاح"); a role alone ("المدير") stays as is. source_self = true if the user explicitly says it is self-initiated ("من نفسي", "مبادرة مني", "أنا المصدر", "من تنظيمي", "من عندي") OR the user is the one delegating/assigning the work to others ("كلّف X", "خلّي X يعمل", "قول لـ X", "أحمد يجهز…" said as an instruction) — a manager delegating is the source, UNLESS the message says someone else assigned that work to the user ("م. مأمون طلبهم مني"): then source = that person and source_self = false. Otherwise source = null and source_self = false.
- Delegation ("كلّف أحمد يجهز التقرير الأحد"): role = "follow", the person is role "followup" (not "waiting") with what = the deliverable and due = the stated date; the task due = the same date.
- One assigner or urgency stated for several tasks («طلبهم مني م. مأمون», «كلهم عاجلين») applies to EACH of those tasks.
- project: if a message names a project once (e.g. starts with "مشروع برج النخيل:"), apply it to EVERY task in that message.
- people: EVERY person mentioned (several are common). name = the person's name only, without titles (م. د. أ.) and without job descriptions. desc = job title/department only if mentioned (e.g. "رئيس قسم العطور محمد عباس" → name "محمد عباس", desc "رئيس قسم العطور"); never put a title like "مهندس" in desc. If only a role is given with no name ("المدير"), set name to that role and generic = true. role "followup" if the user must contact/follow up with them, "waiting" if the user waits for something from them, else "related". what = what is needed from that person (short, formal) or null. due = follow-up date if stated, else null.
- Do NOT add the assigner (source) to people just because they assigned the task; add them only if the user must also follow up with them or wait for something from them.
- If a person matches a known contact below, return the contact's name EXACTLY as written there.
- waiting_what: reply / decision / approval when waiting, else null.

Each log item: title in ${ar ? 'formal MSA starting with a verbal noun (زيارة، فحص، مراجعة، اجتماع مع، إنهاء، تسليم)' : 'English'}, keeping people's names, places, codes and numbers inside the title; date = the day it was done (today unless stated: "امبارح" = yesterday, a weekday name = its most recent past occurrence; never a future date); project only if stated.

Edits: fill only the fields that change. To remove a time use clear_time = true; to stop repeating use clear_recur = true. For a log draft you may change title, date or project.

query.type: due (tasks due between from and to), late, nodue, waiting (tasks waiting on others), followups (open follow-ups grouped by person), person (everything with query.person), project (query.project), done (completed between from and to), summary (overview of today).
Known contacts: ${o.known.length ? o.known.join(' | ') : '(none)'}
Previous task assigners: ${o.sources.length ? o.sources.join(' | ') : '(none)'}`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(req) });
  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const { data: { user } } = await admin.auth.getUser(jwt);
    if (!user) return json(req, { error: 'unauthorized' }, 401);
    if (!Deno.env.get('ANTHROPIC_API_KEY') && !Deno.env.get('GEMINI_API_KEY')) return json(req, { error: 'missing_key' });

    const body = await req.json().catch(() => ({}));
    const text = String(body.text ?? '').slice(0, 4000).trim();
    const long = text.length > 450; // a long list (up to 20 items) needs more output and more time
    if (!text) return json(req, { error: 'empty' }, 400);
    const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today) ? body.today : new Date().toISOString().slice(0, 10);
    const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(today + 'T12:00:00Z').getUTCDay()] ?? '';
    const lang = body.lang === 'en' ? 'en' : 'ar';
    const list = (v: unknown, n: number) => Array.isArray(v) ? v.map((s) => String(s).replace(/[\r\n\t|]+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, n) : [];
    const known = list(body.people, 300), sources = list(body.sources, 30);
    const weekend = Array.isArray(body.weekend) && body.weekend.length && body.weekend.length <= 3 && body.weekend.every((d: unknown) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6) ? body.weekend as number[] : [5, 6];
    // short conversation memory: alternating user/model turns, oldest first
    const turns: { role: string; parts: { text: string }[] }[] = [];
    for (const h of (Array.isArray(body.history) ? body.history : []).slice(-10)) {
      const role = h?.role === 'model' ? 'model' : 'user'; const t = String(h?.text ?? '').slice(0, 600).trim(); if (!t) continue;
      if (turns.length && turns[turns.length - 1].role === role) turns[turns.length - 1].parts[0].text += '\n' + t; else turns.push({ role, parts: [{ text: t }] });
    }
    while (turns.length && turns[0].role !== 'user') turns.shift();
    if (turns.length && turns[turns.length - 1].role === 'user') turns.pop();
    const drafts = JSON.stringify(Array.isArray(body.drafts) ? body.drafts.slice(0, 10) : []).slice(0, 6000);
    const pendingQ = typeof body.pending === 'string' ? body.pending.slice(0, 40) : '';
    const last = `Current drafts (numbered, not saved yet): ${drafts}${pendingQ ? `\nThe app is currently asking the user about: ${pendingQ}` : ''}\n\nUser message:\n${text}`;

    const { data: ok, error: qe } = await admin.rpc('ai_take', { uid: user.id, cap: DAILY_CAP });
    if (qe) { console.error(qe); return json(req, { error: 'server' }, 500); }
    if (ok !== true) return json(req, { error: 'quota' });
    const { data: gok, error: ge } = await admin.rpc('ai_take', { uid: '00000000-0000-0000-0000-000000000000', cap: 1200 }); // all users together, per day — also caps the Claude spend (~$0.0005 a message)
    if (ge) { console.error(ge); return json(req, { error: 'server' }, 500); }
    if (gok !== true) return json(req, { error: 'busy' });

    const system = instructions({ today, weekday, lang, known, sources, weekend });
    const started = Date.now(), budget = long ? 30000 : BUDGET_MS, left = () => budget - (Date.now() - started);
    const errs: string[] = []; // why an engine was skipped (no secrets in here) — returned with a fallback answer to ease diagnosis
    const answer = (res: Record<string, unknown>, model: string) => {
      const out = tidy(res);
      if (body.v !== 2 && ['chat', 'edit', 'save', 'cancel'].includes(out.intent as string)) out.intent = 'other'; // clients before 2.5
      if (errs.length) console.warn('assist fallback', errs.join(' | '));
      return json(req, errs.length ? { result: out, model, skipped: errs } : { result: out, model });
    };

    // 1) Claude — a forced tool call returns the answer as a parsed JSON object that follows the schema
    const akey = Deno.env.get('ANTHROPIC_API_KEY');
    if (akey) {
      const msgs: { role: string; content: string }[] = turns.map((x) => ({ role: x.role === 'model' ? 'assistant' : 'user', content: x.parts[0].text }));
      msgs.push({ role: 'user', content: last });
      const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), Math.min(long ? 24000 : 11000, left()));
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', signal: ctl.signal,
          headers: { 'content-type': 'application/json', 'x-api-key': akey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({
            model: CLAUDE_MODEL, max_tokens: long ? 8000 : 3000, system, messages: msgs,
            tools: [{ name: 'respond', description: 'Your answer to the user\'s last message, following the schema.', input_schema: CLAUDE_SCHEMA }],
            tool_choice: { type: 'tool', name: 'respond' },
            thinking: { type: 'disabled' }, output_config: { effort: 'low' },
          }),
        });
        const c = await r.json().catch(() => ({}));
        if (!r.ok) errs.push('claude:' + r.status + ':' + (c?.error?.type || '') + ':' + String(c?.error?.message || '').slice(0, 120));
        else if (c?.stop_reason === 'max_tokens') errs.push('claude:TRUNCATED');
        else {
          const use = (c?.content || []).find((b: { type: string }) => b.type === 'tool_use');
          if (use?.input && typeof use.input === 'object') return answer(use.input, CLAUDE_MODEL);
          errs.push('claude:NO_TOOL:' + c?.stop_reason);
        }
      } catch (e) { errs.push('claude:' + ((e as { name?: string })?.name === 'AbortError' ? 'TIMEOUT' : String(e))); } finally { clearTimeout(timer); }
    }

    // 2) Gemini — the fallback (or the only engine when there is no Claude key)
    const gkey = Deno.env.get('GEMINI_API_KEY');
    if (gkey) {
      const payload = {
        systemInstruction: { parts: [{ text: system }] },
        contents: [...turns, { role: 'user', parts: [{ text: last }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: long ? 8000 : 3000, responseMimeType: 'application/json', responseSchema: SCHEMA, thinkingConfig: { thinkingLevel: 'minimal' } },
      };
      for (const model of [...new Set(MODELS)]) {
        if (left() < 3000) break;
        const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), Math.min(long ? 20000 : 9000, left()));
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
            method: 'POST', signal: ctl.signal,
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': gkey },
            body: JSON.stringify(payload),
          });
          const g = await r.json().catch(() => ({}));
          if (!r.ok) { errs.push('gemini:' + (g?.error?.status || r.status)); if ([400, 404, 429, 503].includes(r.status)) continue; break; }
          if (g?.candidates?.[0]?.finishReason === 'MAX_TOKENS') { errs.push('gemini:TRUNCATED'); continue; }
          const out = g?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text ?? '').join('') ?? '';
          return answer(JSON.parse(out), model);
        } catch (e) { errs.push('gemini:' + ((e as { name?: string })?.name === 'AbortError' ? 'TIMEOUT' : String(e))); } finally { clearTimeout(timer); }
      }
    }

    console.warn('assist failed', errs.join(' | '));
    const all = errs.join(' ');
    if (/TIMEOUT/.test(all) && !/:(4\d\d|5\d\d)/.test(all)) return json(req, { error: 'timeout' });
    if (/429|529|RESOURCE_EXHAUSTED|503|UNAVAILABLE|overloaded|rate_limit|TIMEOUT/.test(all)) return json(req, { error: 'busy' });
    return json(req, { error: 'engine' }, 502);
  } catch (e) {
    console.error(e);
    return json(req, { error: 'server' }, 500);
  }
});

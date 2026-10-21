// Mir'ah Smart Assistant: a small Cloudflare Worker that keeps the Claude API key off the public site.
// Paste this file into a Worker in the Cloudflare dashboard and add the secret ANTHROPIC_API_KEY.
// It uses fetch directly because a dashboard Worker has no build step to bundle the Anthropic SDK.

const MODEL = 'claude-haiku-5-5';          // fast, low-cost model; 'claude-opus-5-5' is smarter but about 40x the price
const ALLOWED_ORIGINS = ['https://mirah-app.github.io', 'https://ayhamaq93-ux.github.io'];
const DAILY_LIMIT_PER_IP = 30;            // soft limit, kept per Worker instance

const RULES = `أنت «المساعد الذكي» داخل تطبيق مرآة. مهمتك: ألا يتوه أي مستخدم. تجيب عن أي سؤال عن التطبيق (الميزات، الأسعار، الخصوصية، طريقة الفحص، معنى النتيجة) أو عن العافية والصحة اليومية (النوم، التوتر، التنفس، النشاط، الماء، الصيام).
قواعد ثابتة: لا تشخّص أي مرض ولا تقترح أدوية أو جرعات. قل «مؤشر» لا «تشخيص». عند أعراض خطيرة (ألم صدر، ضيق نفس، إغماء، أفكار إيذاء النفس) وجّه فوراً للطوارئ برقم البلد. إذا كانت القراءة غير معتادة جداً (نبض راحة فوق 110 أو تحت 45) انصح بلطف بمراجعة طبيب. لا تخترع أرقاماً أو ميزات أو أسعاراً غير المذكورة. إذا كان السؤال خارج الصحة والتطبيق، أجب بجملة لطيفة وأعد الحديث لما تقدر تساعد فيه. كن قصيراً وواضحاً ودافئاً.`;

const KB = `معلومات عن تطبيق مرآة (Mir'ah):
- رفيق صحي يومي على الجوال. يطلق حالياً في الأردن ومصر، بالعربية (لهجة أردنية أو مصرية) والإنجليزية.
- فحص 30 ثانية بسيلفي فيديو يقرأ من الوجه بتقنية rPPG: نبض الراحة، تباين النبض HRV (RMSSD)، معدل التنفس، ومؤشر التوتر.
- «نتيجة مرآة» من 100 = راحة القلب 25 + التوازن والتوتر 30 + التنفس 15 + النوم والشعور (سؤالان) 20 + الانتظام آخر 7 أيام 10. 0-49 محتاج انتباه، 50-74 منيح/كويس، 75-100 ممتاز.
- مع كل نتيجة درجة ثقة (عالية/متوسطة)، وإذا كانت الإشارة ضعيفة لا تظهر نتيجة ويُطلب إعادة الفحص. نصائح لفحص أفضل: ضوء طبيعي أمام الوجه، الجوال ثابت، عدم الكلام، إبعاد الشعر عن الجبهة.
- الخصوصية: الفيديو يُحلَّل على جهاز المستخدم ولا يُرفع أبداً، وتُحفظ الأرقام فقط مشفّرة، وفق قانون حماية البيانات الأردني رقم 24 لسنة 2023 والمصري رقم 151 لسنة 2020.
- الباقات (أسعار رمزية بالدولار وتدفع بالعملة المحلية): مجاني 0$ (فحص يومي + النتيجة + 5 أسئلة للمساعد يومياً)؛ بلس 1.99$ شهرياً أو 14.99$ سنوياً (فحص ومساعد بلا حدود، اتجاهات شهرية، تقرير للطبيب)؛ العيلة 3.99$ شهرياً (حتى 5 أفراد، متابعة الأهل بموافقتهم من أي بلد)؛ للأعمال 1$ للموظف شهرياً (لوحة عافية مجمّعة لا تكشف أحداً). الدفع: CliQ و eFAWATEERcom في الأردن، فوري والمحافظ الإلكترونية في مصر.
- الميزات: النتيجة اليومية، تقرير اليوم، المساعد الذكي، متابعة العيلة، تقرير أسبوعي للطبيب يُشارك بضغطة، تحدي 7 أيام.
- مرآة منتج عافية وليس جهازاً طبياً، ولا يشخّص. الطوارئ: 911 في الأردن، 123 للإسعاف في مصر.`;

const DIALECT = {"jo": "احكِ باللهجة الأردنية البيضاء المفهومة (مثل: شو، هلّق، منيح، بدك، كثير، إشي) بدون مبالغة.", "eg": "اتكلم باللهجة المصرية المفهومة (زي: إيه، دلوقتي، كويس، عايز، أوي، حاجة) من غير مبالغة.", "en": "Reply in clear, warm, simple English."};

const counts = new Map();
let countsDay = '';

function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
}
const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST' || !allowed) return json({ error: 'forbidden' }, 403, cors);

    const today = new Date().toISOString().slice(0, 10);
    if (today !== countsDay) { counts.clear(); countsDay = today; }
    const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
    const used = (counts.get(ip) || 0) + 1;
    if (used > DAILY_LIMIT_PER_IP) return json({ error: 'limit' }, 429, cors);
    counts.set(ip, used);

    let body;
    try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400, cors); }
    const q = clip(body.q, 500).trim();
    const lang = DIALECT[body.lang] ? body.lang : 'jo';
    if (!q) return json({ error: 'empty' }, 400, cors);

    const messages = [];
    const history = Array.isArray(body.history) ? body.history.slice(-4) : [];
    for (const t of history) {
      const hq = clip(t && t.q, 500), ha = clip(t && t.a, 1200);
      if (hq && ha) messages.push({ role: 'user', content: hq }, { role: 'assistant', content: ha });
    }
    messages.push({ role: 'user', content: clip(body.context, 1500) + '\n\nسؤال المستخدم: ' + q });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        system: [
          { type: 'text', text: RULES + '\n\n' + KB, cache_control: { type: 'ephemeral' } },
          { type: 'text', text: DIALECT[lang] + '\nأجب في 70 كلمة أو أقل، بنفس اللغة واللهجة المطلوبة.' },
        ],
        messages,
        output_config: { effort: 'low' },
      }),
    });
    if (!res.ok) return json({ error: 'upstream ' + res.status }, 502, cors);
    const data = await res.json();
    if (data.stop_reason === 'refusal') return json({ text: null }, 200, cors);
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
    return json({ text: text || null }, 200, cors);
  },
};

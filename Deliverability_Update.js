const fs = require('fs');
const path = require('path');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

let geoip = null;
try { geoip = require('geoip-lite'); } catch { geoip = null; }

const ISPS_MLJ = ['Hotmail', 'Outlook', 'Gmail', 'Yahoo', 'Aol', 'iCloud', 'Other'];
const ISPS_SEG = ['Outlook', 'Hotmail', 'Gmail', 'Yahoo', 'iCloud', 'Aol', 'Other'];
const MESES_CARPETA = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
];
const MESES_CARPETA_CAP = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
];
const MESES_CORTOS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function obtenerAyerColombia() {
    const ahoraCol = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const hoyCol = ahoraCol.toISOString().slice(0, 10);
    const ayerCol = new Date(ahoraCol.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return { hoyCol, ayerCol };
}

const ISP_EXACT = {
    'gmail.com': 'Gmail', 'googlemail.com': 'Gmail',
    'hotmail.com': 'Hotmail', 'hotmail.ca': 'Hotmail', 'hotmail.fr': 'Hotmail',
    'hotmail.es': 'Hotmail', 'hotmail.de': 'Hotmail', 'hotmail.co.uk': 'Hotmail',
    'hotmail.co.nz': 'Hotmail', 'hotmail.com.ar': 'Hotmail', 'hotmail.com.mx': 'Hotmail',
    'outlook.com': 'Outlook', 'outlook.es': 'Outlook', 'outlook.com.ar': 'Outlook',
    'outlook.co.nz': 'Outlook', 'live.com': 'Outlook', 'live.ca': 'Outlook',
    'live.fr': 'Outlook', 'live.com.ar': 'Outlook', 'msn.com': 'Outlook',
    'yahoo.com': 'Yahoo', 'yahoo.ca': 'Yahoo', 'yahoo.co.uk': 'Yahoo',
    'yahoo.fr': 'Yahoo', 'yahoo.de': 'Yahoo', 'yahoo.es': 'Yahoo',
    'yahoo.com.ar': 'Yahoo', 'yahoo.com.mx': 'Yahoo', 'ymail.com': 'Yahoo', 'y7mail.com': 'Yahoo',
    'aol.com': 'Aol', 'aol.co.uk': 'Aol', 'aim.com': 'Aol',
    'icloud.com': 'iCloud', 'me.com': 'iCloud', 'mac.com': 'iCloud'
};

const ISP_KEYWORDS = [
    ['gmail', 'Gmail'], ['googlemail', 'Gmail'],
    ['hotmail', 'Hotmail'], ['outlook', 'Outlook'], ['live.', 'Outlook'],
    ['yahoo', 'Yahoo'], ['ymail', 'Yahoo'],
    ['aol.', 'Aol'], ['icloud', 'iCloud']
];

function classifyISP(valor) {
    if (!valor) return 'Other';
    let text = String(valor).toLowerCase().trim();
    if (text.includes('@')) text = text.split('@').pop();
    text = text.replace(/\s+/g, '').replace('apple', 'icloud');
    if (ISP_EXACT[text]) return ISP_EXACT[text];
    for (const [kw, name] of ISP_KEYWORDS) {
        if (text.includes(kw)) return name;
    }
    return 'Other';
}

function extraerDominioEmail(valor) {
    if (!valor) return 'Unknown';
    let text = String(valor).trim().toLowerCase();
    const m = text.match(/<([^>]+)>/);
    if (m) text = m[1].trim();
    if (text.includes('@')) text = text.split('@').pop().trim();
    return text || 'Unknown';
}

function nuevoMapaISPs() {
    const mapa = {};
    for (const isp of ISPS_MLJ) {
        mapa[isp] = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0, Complaint: 0, UnsubBlocked: 0 };
    }
    return mapa;
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// =======================================================
// 0. MAPA DE CÓDIGOS DE CAMPAÑA -> BRAND
// =======================================================
function cargarMapaCodigos(anioNum, mesNum) {
    const codeToBrand = {};
    const rutaCodes = path.join(String(anioNum), 'Campaign codes', MESES_CARPETA_CAP[mesNum - 1], 'campaign_codes.json');
    try {
        if (fs.existsSync(rutaCodes)) {
            const raw = JSON.parse(fs.readFileSync(rutaCodes, 'utf8'));
            const mapa = raw?.brands || raw || {};
            for (const [brand, codesStr] of Object.entries(mapa)) {
                for (const c of String(codesStr || '').split(/[,;\s]+/)) {
                    const code = c.trim().toUpperCase();
                    if (code) codeToBrand[code] = brand.trim();
                }
            }
            console.log(`Campaign codes cargados (${Object.keys(codeToBrand).length} codigos) desde: ${rutaCodes}`);
        }
    } catch (e) {
        console.warn(`Aviso leyendo ${rutaCodes}: ${e.message}`);
    }
    return codeToBrand;
}

function extraerCodigoCampana(titulo) {
    if (!titulo) return '';
    const clean = String(titulo).replace(/^Copy of\s+/i, '').replace(/\s*-\s*Draft$/i, '').replace(/\s*\(Copy\)$/i, '').trim();
    const m = clean.match(/^(?:MLJ(?:SH|1|2)|SEGSH|SEG)(?:US|CA|NZ|UK)?\d{3,4}([A-Za-z]+?)(?:[a-z]+)?$/);
    if (m) return m[1].toUpperCase();
    const m2 = clean.match(/\d{3,4}([A-Za-z]+?)(?:[a-z])?$/);
    if (m2) return m2[1].toUpperCase();
    return '';
}

function resolverBrandPorTitulo(titulo, codeToBrand) {
    if (!titulo) return 'Unknown';
    const clean = String(titulo).replace(/^Copy of\s+/i, '').replace(/\s*-\s*Draft$/i, '').replace(/\s*\(Copy\)$/i, '').trim();
    const codigosOrdenados = Object.keys(codeToBrand).sort((a, b) => b.length - a.length);

    const exactCode = extraerCodigoCampana(clean);
    if (exactCode && codeToBrand[exactCode]) return codeToBrand[exactCode];

    const mTail = clean.match(/\d{3,4}([A-Za-z]+)$/);
    const tail = mTail ? mTail[1].toUpperCase() : clean.toUpperCase();
    for (const code of codigosOrdenados) {
        if (tail === code || tail.startsWith(code)) return codeToBrand[code];
    }

    return exactCode || clean || 'Unknown';
}

// =======================================================
// 1. MAILJET (ISP + Dominio/Subdominio + Brand por Campaña)
// =======================================================
async function fetchMailjetPage(url, headers, intentos = 3) {
    for (let i = 1; i <= intentos; i++) {
        try {
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
            if (res.ok) {
                const raw = await res.text();
                return JSON.parse(raw.replace(/:\s*(\d{16,})(?=[,\s}\]])/g, ':"$1"'));
            }
            if ([429, 500, 502, 503, 504].includes(res.status) && i < intentos) {
                await esperar(i * 2000);
                continue;
            }
            throw new Error(`Mailjet HTTP ${res.status} en ${url}`);
        } catch (err) {
            if (i === intentos) throw err;
            await esperar(i * 2000);
        }
    }
}

async function fetchAllMailjet(urlBase, headers) {
    const todos = [];
    let offset = 0;
    const limit = 1000;
    while (true) {
        const sep = urlBase.includes('?') ? '&' : '?';
        const json = await fetchMailjetPage(`${urlBase}${sep}Limit=${limit}&Offset=${offset}`, headers);
        const data = json.Data || [];
        todos.push(...data);
        if (data.length < limit) break;
        offset += limit;
    }
    return todos;
}

async function procesarMailjet(nombreCuenta, apiKey, secretKey, fechaStr, codeToBrand = {}) {
    const auth = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };
    const [y, m, d] = fechaStr.split('-').map(Number);

    const fromMs = Date.UTC(y, m - 1, d, 5, 0, 0, 0);
    const toMs = Date.UTC(y, m - 1, d + 1, 4, 59, 59, 999);
    const fromTS = new Date(fromMs).toISOString().slice(0, 19) + 'Z';
    const toTS = new Date(Date.UTC(y, m - 1, d + 1, 5, 0, 0)).toISOString().slice(0, 19) + 'Z';

    const enAyer = (iso) => {
        if (!iso) return true;
        const t = Date.parse(iso);
        return Number.isNaN(t) || (t >= fromMs && t <= toMs);
    };

    const porISP = nuevoMapaISPs();
    const porDominio = {};
    const porBrand = {};

    const senderMap = {};
    try {
        const senders = await fetchAllMailjet('https://api.mailjet.com/v3/REST/sender', headers);
        for (const s of senders) {
            if (s.ID != null && s.Email) {
                const dom = extraerDominioEmail(s.Email);
                senderMap[String(s.ID)] = dom;
                if ((!s.Status || String(s.Status).toLowerCase() === 'active') && dom && dom !== 'Unknown') {
                    if (!porDominio[dom]) porDominio[dom] = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0 };
                }
            }
        }
    } catch (e) {
        console.warn(`${nombreCuenta} aviso senders (${e.message})`);
    }

    const mensajes = await fetchAllMailjet(
        `https://api.mailjet.com/v3/REST/message?FromTS=${fromTS}&ToTS=${toTS}&ShowContactAlt=true&ShowSubject=true`,
        headers
    );

    // Resolver CampaignID -> Draft Title -> Brand
    const campBrandMap = {};
    const campIds = [...new Set(mensajes.map(x => String(x.CampaignID || '')).filter(id => id && id !== '0'))];
    for (const cid of campIds) {
        try {
            const cRes = await fetchMailjetPage(`https://api.mailjet.com/v3/REST/campaign/${cid}`, headers);
            const cObj = cRes?.Data?.[0];
            let title = cObj?.Subject || '';
            if (cObj?.NewsLetterID) {
                const dRes = await fetchMailjetPage(`https://api.mailjet.com/v3/REST/campaigndraft/${cObj.NewsLetterID}`, headers).catch(() => null);
                if (dRes?.Data?.[0]?.Title) title = dRes.Data[0].Title;
            }
            campBrandMap[cid] = resolverBrandPorTitulo(title, codeToBrand);
        } catch (e) {
            campBrandMap[cid] = 'Unknown';
        }
    }

    let openIds = null;
    try {
        const opens = await fetchAllMailjet(
            `https://api.mailjet.com/v3/REST/openinformation?FromTS=${fromTS}&ToTS=${toTS}`,
            headers
        );
        openIds = new Set(opens.filter(o => enAyer(o.OpenedAt)).map(o => String(o.MessageID)));
    } catch (e) {
        console.warn(`${nombreCuenta} aviso openinformation (${e.message}) -> usando Status del mensaje`);
    }

    let clickIds = null;
    try {
        const clicks = await fetchAllMailjet(
            `https://api.mailjet.com/v3/REST/clickstatistics?FromTS=${fromTS}&ToTS=${toTS}`,
            headers
        );
        clickIds = new Set(clicks.filter(c => enAyer(c.ClickedAt)).map(c => String(c.MessageID)));
    } catch (e) {
        console.warn(`${nombreCuenta} aviso clickstatistics (${e.message}) -> usando Status del mensaje`);
    }

    for (const msg of mensajes) {
        if (msg.ArrivedAt && !enAyer(msg.ArrivedAt)) continue;
        const campId = Number(msg.CampaignID || 0);
        const subj = String(msg.Subject || '');
        if (campId === 0 || /\[test\]|\btest\b/i.test(subj)) continue;

        const idStr = String(msg.ID);
        const st = String(msg.Status || '').toLowerCase();
        const isp = classifyISP(msg.ContactAlt);
        const domRemitente = (msg.SenderID != null && senderMap[String(msg.SenderID)]) || 'Unknown';
        const brandName = campBrandMap[String(campId)] || 'Unknown';

        const blocked = st === 'blocked';
        const soft = st.includes('soft') || (st === 'bounce' && !msg.StatePermanent);
        const hard = st.includes('hard') || (st === 'bounce' && Boolean(msg.StatePermanent));
        const unsub = st === 'unsub';
        const spam = st === 'spam';
        const clicked = (clickIds ? clickIds.has(idStr) : false) || st === 'clicked';
        const opened = (openIds ? openIds.has(idStr) : st === 'clicked') || st === 'opened';
        const delivered = !(hard || soft || blocked);

        const r = porISP[isp];
        if (delivered) r.Delivered += 1;
        if (soft) r.SoftBounce += 1;
        if (hard) r.HardBounce += 1;
        if (opened) r.Open += 1;
        if (clicked) r.Click += 1;
        if (spam) r.Complaint += 1;
        if (unsub || blocked) r.UnsubBlocked += 1;

        if (!porDominio[domRemitente]) porDominio[domRemitente] = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0 };
        const dRow = porDominio[domRemitente];
        if (delivered) dRow.Delivered += 1;
        if (soft) dRow.SoftBounce += 1;
        if (hard) dRow.HardBounce += 1;
        if (opened) dRow.Open += 1;
        if (clicked) dRow.Click += 1;

        if (!porBrand[brandName]) porBrand[brandName] = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0 };
        const bRow = porBrand[brandName];
        if (delivered) bRow.Delivered += 1;
        if (soft) bRow.SoftBounce += 1;
        if (hard) bRow.HardBounce += 1;
        if (opened) bRow.Open += 1;
        if (clicked) bRow.Click += 1;
    }

    return { porISP, porDominio, porBrand };
}

// =======================================================
// 2. SENDGRID - ESTADÍSTICAS POR ISP + GEO
// =======================================================
async function procesarSendgrid(apiKey, fechaStr) {
    const headers = { Authorization: `Bearer ${apiKey}` };
    const porISP = nuevoMapaISPs();
    const estados = {};

    const resISP = await fetch(
        `https://api.sendgrid.com/v3/mailbox_providers/stats?start_date=${fechaStr}&end_date=${fechaStr}&aggregated_by=day`,
        { headers }
    );
    if (!resISP.ok) throw new Error(`SendGrid ISP HTTP ${resISP.status}`);
    const dataISP = await resISP.json();

    for (const dia of (Array.isArray(dataISP) ? dataISP : [])) {
        for (const s of (dia.stats || [])) {
            const isp = classifyISP(s.name);
            const m = s.metrics || {};
            porISP[isp].Delivered += m.delivered || 0;
            porISP[isp].SoftBounce += m.blocks || 0;
            porISP[isp].HardBounce += m.bounces || 0;
            porISP[isp].Open += m.opens || 0;
            porISP[isp].Click += m.clicks || 0;
            porISP[isp].Complaint += m.spam_reports || 0;
            porISP[isp].UnsubBlocked += m.unsubscribes || 0;
        }
    }

    const resGeo = await fetch(
        `https://api.sendgrid.com/v3/geo/stats?start_date=${fechaStr}&end_date=${fechaStr}&aggregated_by=day&country=US`,
        { headers }
    );
    if (resGeo.ok) {
        const dataGeo = await resGeo.json();
        for (const dia of (Array.isArray(dataGeo) ? dataGeo : [])) {
            for (const s of (dia.stats || [])) {
                const st = String(s.name || '').trim().toUpperCase();
                if (!st || st === 'ALL' || st === 'US') continue;
                const c = (s.metrics && s.metrics.clicks) ? s.metrics.clicks : 0;
                if (c > 0) estados[st] = (estados[st] || 0) + c;
            }
        }
    }

    return { porISP, estados };
}

// =======================================================
// 2B. SENDGRID - BREAKDOWN POR DOMINIO / SUBDOMINIO
// =======================================================
function parseResetMs(resetHeader) {
    if (!resetHeader) return 0;
    const n = Number(resetHeader);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return n > 1e9 ? n * 1000 : Date.now() + n * 1000;
}

async function procesarSendgridDominios(nombreCuenta, apiKey, fechaStr) {
    const headers = { Authorization: `Bearer ${apiKey}` };
    const [y, m, d] = fechaStr.split('-').map(Number);

    const fromMs = Date.UTC(y, m - 1, d, 5, 0, 0, 0);
    const toMs = Date.UTC(y, m - 1, d + 1, 4, 59, 59, 999);
    const fromSec = Math.floor(fromMs / 1000);
    const toSec = Math.floor(toMs / 1000);

    const porDominio = {};
    const asegurarDom = (dom) => {
        if (!dom || dom === 'Unknown') return null;
        if (!porDominio[dom]) {
            porDominio[dom] = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0 };
        }
        return porDominio[dom];
    };

    try {
        const [rWl, rVs, rMs] = await Promise.all([
            fetch('https://api.sendgrid.com/v3/whitelabel/domains?limit=500', { headers, signal: AbortSignal.timeout(15000) }).catch(() => null),
            fetch('https://api.sendgrid.com/v3/verified_senders?limit=500', { headers, signal: AbortSignal.timeout(15000) }).catch(() => null),
            fetch('https://api.sendgrid.com/v3/marketing/senders', { headers, signal: AbortSignal.timeout(15000) }).catch(() => null)
        ]);
        if (rWl && rWl.ok) {
            const wl = await rWl.json().catch(() => []);
            for (const item of (Array.isArray(wl) ? wl : [])) {
                if (item.domain) asegurarDom(String(item.domain).trim().toLowerCase());
            }
        }
        if (rVs && rVs.ok) {
            const vs = await rVs.json().catch(() => ({}));
            for (const item of (Array.isArray(vs.results) ? vs.results : [])) {
                if (item.from_email) asegurarDom(extraerDominioEmail(item.from_email));
            }
        }
        if (rMs && rMs.ok) {
            const ms = await rMs.json().catch(() => []);
            const arr = Array.isArray(ms) ? ms : (Array.isArray(ms.results) ? ms.results : []);
            for (const item of arr) {
                const em = item.from?.email || item.from_email;
                if (em) asegurarDom(extraerDominioEmail(em));
            }
        }
    } catch {}

    async function fetchSuppresions(endpoint) {
        const set = new Set();
        let offset = 0;
        const limit = 500;
        while (true) {
            try {
                const res = await fetch(
                    `https://api.sendgrid.com/v3/suppression/${endpoint}?start_time=${fromSec}&end_time=${toSec}&limit=${limit}&offset=${offset}`,
                    { headers, signal: AbortSignal.timeout(20000) }
                );
                if (!res.ok) break;
                const data = await res.json();
                if (!Array.isArray(data) || !data.length) break;
                for (const item of data) {
                    if (item.email) set.add(String(item.email).trim().toLowerCase());
                }
                if (data.length < limit) break;
                offset += limit;
            } catch {
                break;
            }
        }
        return set;
    }

    const [bouncedEmails, invalidEmails, blockedEmails] = await Promise.all([
        fetchSuppresions('bounces'),
        fetchSuppresions('invalid_emails'),
        fetchSuppresions('blocks')
    ]);
    for (const em of invalidEmails) bouncedEmails.add(em);

    let nextAllowedAt = 0;

    async function sgActivityFetch(url, intentos = 8) {
        for (let i = 1; i <= intentos; i++) {
            const esperaAntes = nextAllowedAt - Date.now();
            if (esperaAntes > 0) await esperar(esperaAntes);

            try {
                const res = await fetch(url, { headers, signal: AbortSignal.timeout(60000) });
                const rem = res.headers.get('x-ratelimit-remaining');
                const resetMs = parseResetMs(res.headers.get('x-ratelimit-reset'));

                if (rem !== null && Number(rem) <= 0) {
                    nextAllowedAt = Math.max(Date.now() + 12000, resetMs > 0 ? resetMs + 2000 : 0);
                }

                if (res.ok) return await res.json();

                if (res.status === 429 && i < intentos) {
                    const backoff = Math.min(65000, i * 15000);
                    const waitMs = Math.max(backoff, resetMs > 0 ? (resetMs - Date.now() + 2000) : 0);
                    console.log(`${nombreCuenta} RateLimit /v3/messages (intento ${i}/${intentos}), esperando ${Math.ceil(waitMs / 1000)}s...`);
                    nextAllowedAt = Date.now() + waitMs;
                    continue;
                }
                if ([500, 502, 503, 504].includes(res.status) && i < intentos) {
                    await esperar(i * 3000);
                    continue;
                }
                const errTxt = await res.text().catch(() => '');
                throw new Error(`SendGrid /v3/messages HTTP ${res.status} ${errTxt}`);
            } catch (err) {
                if (i < intentos && !String(err.message).includes('HTTP 4')) {
                    console.log(`${nombreCuenta} aviso red/timeout (intento ${i}/${intentos}): ${err.message}, reintentando...`);
                    await esperar(i * 5000);
                    continue;
                }
                throw err;
            }
        }
    }

    const msgMap = new Map();

    async function fetchWindow(startMs, endMs, extraFilter = '') {
        const startIso = new Date(startMs).toISOString().slice(0, 19) + 'Z';
        const endIso = new Date(endMs).toISOString().slice(0, 19) + 'Z';
        const query = `last_event_time BETWEEN TIMESTAMP "${startIso}" AND TIMESTAMP "${endIso}"${extraFilter}`;
        const url = `https://api.sendgrid.com/v3/messages?limit=1000&query=${encodeURIComponent(query)}`;

        const json = await sgActivityFetch(url);
        const msgs = Array.isArray(json.messages) ? json.messages : [];
        for (const msg of msgs) {
            if (msg.msg_id) msgMap.set(msg.msg_id, msg);
        }

        if (msgs.length >= 1000) {
            const spanSec = Math.floor((endMs - startMs) / 1000);
            if (spanSec > 1) {
                const midSec = Math.floor((startMs + endMs) / 2000);
                const midMs = midSec * 1000;
                await fetchWindow(startMs, midMs, extraFilter);
                await fetchWindow(midMs, endMs, extraFilter);
            } else if (!extraFilter) {
                await fetchWindow(startMs, endMs, ' AND status="delivered"');
                await fetchWindow(startMs, endMs, ' AND status="not_delivered"');
                await fetchWindow(startMs, endMs, ' AND status="processing"');
            } else if (extraFilter === ' AND status="delivered"') {
                await fetchWindow(startMs, endMs, ' AND status="delivered" AND to_email < "f"');
                await fetchWindow(startMs, endMs, ' AND status="delivered" AND to_email >= "f" AND to_email < "l"');
                await fetchWindow(startMs, endMs, ' AND status="delivered" AND to_email >= "l" AND to_email < "r"');
                await fetchWindow(startMs, endMs, ' AND status="delivered" AND to_email >= "r"');
            }
        }
    }

    const stepMs = 6 * 60 * 60 * 1000;
    for (let t = fromMs; t < toMs; t += stepMs) {
        await fetchWindow(t, Math.min(t + stepMs - 1000, toMs));
    }
    console.log(`${nombreCuenta} mensajes recuperados por actividad: ${msgMap.size}`);

    const unresolved = [];

    for (const msg of msgMap.values()) {
        const dom = extraerDominioEmail(msg.from_email);
        const dRow = asegurarDom(dom) || (porDominio.Unknown = porDominio.Unknown || { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0 });
        const st = String(msg.status || '').toLowerCase();

        if (st === 'delivered') {
            dRow.Delivered += 1;
        } else if (st === 'not_delivered') {
            const toEm = String(msg.to_email || '').trim().toLowerCase();
            if (bouncedEmails.has(toEm)) {
                dRow.HardBounce += 1;
            } else if (blockedEmails.has(toEm)) {
                dRow.SoftBounce += 1;
            } else {
                unresolved.push({ msgId: msg.msg_id, dom: dom || 'Unknown' });
            }
        }

        dRow.Open += Number(msg.opens_count || 0);
        dRow.Click += Number(msg.clicks_count || 0);
    }

    for (let i = 0; i < unresolved.length; i++) {
        const { msgId, dom } = unresolved[i];
        const dRow = porDominio[dom] || (porDominio[dom] = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0 });
        if (i < 15 && msgId) {
            try {
                const detail = await sgActivityFetch(`https://api.sendgrid.com/v3/messages/${encodeURIComponent(msgId)}`);
                const evs = Array.isArray(detail.events) ? detail.events.map(e => String(e.event_name || '').toLowerCase()) : [];
                if (evs.includes('bounce') || evs.includes('dropped')) dRow.HardBounce += 1;
                else dRow.SoftBounce += 1;
                continue;
            } catch {}
        }
        dRow.SoftBounce += 1;
    }

    return porDominio;
}

// =======================================================
// 2C. SENDGRID - BREAKDOWN POR BRAND (SINGLE SENDS STATS)
// =======================================================
async function procesarSendgridBrands(nombreCuenta, apiKey, fechaStr, codeToBrand = {}, softBounceTotal = 0) {
    const headers = { Authorization: `Bearer ${apiKey}` };
    const porBrand = {};
    const targetMs = Date.parse(`${fechaStr}T12:00:00Z`);
    const singlesends = [];

    let nextUrl = 'https://api.sendgrid.com/v3/marketing/singlesends?page_size=100';
    for (let page = 0; page < 5 && nextUrl; page++) {
        const res = await fetch(nextUrl, { headers, signal: AbortSignal.timeout(15000) });
        if (!res.ok) break;
        const json = await res.json();
        singlesends.push(...(Array.isArray(json.result) ? json.result : []));
        const nxt = json._metadata?.next;
        nextUrl = nxt ? (nxt.startsWith('http') ? nxt : `https://api.sendgrid.com${nxt}`) : null;
    }

    const candidatos = singlesends.filter(ss => {
        if (ss.status !== 'triggered' || !ss.id || !ss.send_at) return false;
        const t = Date.parse(ss.send_at);
        return Number.isNaN(t) || Math.abs(targetMs - t) <= 10 * 24 * 60 * 60 * 1000;
    });

    for (const ss of candidatos) {
        try {
            const stRes = await fetch(
                `https://api.sendgrid.com/v3/marketing/stats/singlesends/${ss.id}?aggregated_by=day&start_date=${fechaStr}&end_date=${fechaStr}`,
                { headers, signal: AbortSignal.timeout(15000) }
            );
            if (!stRes.ok) continue;
            const stJson = await stRes.json();
            const results = Array.isArray(stJson.results) ? stJson.results : [];
            let deliv = 0, hard = 0, opens = 0, clicks = 0;
            for (const r of results) {
                const m = r.stats || {};
                deliv += Number(m.delivered || 0);
                hard += Number(m.bounces || 0) + Number(m.invalid_emails || 0) + Number(m.bounce_drops || 0);
                opens += Number(m.opens || 0);
                clicks += Number(m.clicks || 0);
            }
            if (deliv + hard + opens + clicks > 0) {
                const brand = resolverBrandPorTitulo(ss.name, codeToBrand);
                if (!porBrand[brand]) porBrand[brand] = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0 };
                porBrand[brand].Delivered += deliv;
                porBrand[brand].HardBounce += hard;
                porBrand[brand].Open += opens;
                porBrand[brand].Click += clicks;
            }
        } catch {}
    }

    const activeEntries = Object.entries(porBrand);
    if (softBounceTotal > 0 && activeEntries.length > 0) {
        if (activeEntries.length === 1) {
            activeEntries[0][1].SoftBounce += softBounceTotal;
        } else {
            const totDeliv = activeEntries.reduce((a, [, v]) => a + (v.Delivered || 0), 0);
            let rem = softBounceTotal;
            activeEntries.forEach(([, v], idx) => {
                if (idx === activeEntries.length - 1) {
                    v.SoftBounce += rem;
                } else {
                    const part = totDeliv > 0 ? Math.round((v.Delivered / totDeliv) * softBounceTotal) : Math.floor(softBounceTotal / activeEntries.length);
                    v.SoftBounce += part;
                    rem -= part;
                }
            });
        }
    }

    console.log(`${nombreCuenta} brands recuperadas por Single Sends: ${Object.keys(porBrand).length}`);
    return porBrand;
}

// =======================================================
// 3. CLOUDFLARE D1 (solo clics de AYER -> Estados USA)
// =======================================================
async function obtenerEstadosCloudflare(urlBase, fechaStr) {
    const porCuenta = { MLJ1: {}, MLJ2: {}, MLJ_SH: {} };
    if (!urlBase || !urlBase.startsWith('http') || !geoip) return porCuenta;

    const sep = urlBase.includes('?') ? '&' : '?';
    const res = await fetch(`${urlBase}${sep}fecha=${fechaStr}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const clics = json.clics || [];
    console.log(`Cloudflare D1 clics encontrados para ${fechaStr}: ${clics.length}`);

    for (const c of clics) {
        if (c.fecha !== fechaStr || !c.ip || Number(c.campaign_id || 0) === 0) continue;
        const geo = geoip.lookup(c.ip);
        if (geo && geo.country === 'US' && geo.region) {
            const cta = c.cuenta || 'MLJ1';
            if (!porCuenta[cta]) porCuenta[cta] = {};
            const st = String(geo.region).toUpperCase();
            porCuenta[cta][st] = (porCuenta[cta][st] || 0) + 1;
        }
    }
    return porCuenta;
}

// =======================================================
// 4. GUARDAR CSVs:
//    A) {año}/maildata/maildata_{mes}/{dia}.csv
//    B) {año}/ESP - IP Breakdown/{Mes}/{dia}.csv
//    C) {año}/ESP-Brand/{Mes}/{dia_2_digitos}.csv
// =======================================================
const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(2) + '%' : '0.00%');

function formatEstados(mapa) {
    const items = Object.entries(mapa || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    return items.length ? items.map(([k, v]) => `${k}: ${v}`).join(' | ') : '';
}

function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function filaCSV(esp, domain, m, usStates = '') {
    return [
        esp, domain,
        m.Delivered, m.SoftBounce, m.HardBounce,
        m.Open, pct(m.Open, m.Delivered),
        m.Click, pct(m.Click, m.Open), pct(m.Click, m.Delivered),
        m.Complaint, m.UnsubBlocked,
        '', '', '', usStates, ''
    ].map(csvCell).join(',');
}

function sumarBloque(porISP) {
    const tot = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0, Complaint: 0, UnsubBlocked: 0 };
    for (const m of Object.values(porISP)) {
        for (const k of Object.keys(tot)) tot[k] += m[k];
    }
    return tot;
}

function sumarBloqueMapa(porClave) {
    const tot = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0 };
    for (const m of Object.values(porClave || {})) {
        for (const k of Object.keys(tot)) tot[k] += (m[k] || 0);
    }
    return tot;
}

function filaBreakdownCSV(nombre, m) {
    const vol = (m.Delivered || 0) + (m.SoftBounce || 0) + (m.HardBounce || 0);
    return [
        nombre,
        vol,
        m.Delivered || 0,
        m.SoftBounce || 0,
        m.HardBounce || 0,
        m.Open || 0,
        m.Click || 0
    ].map(csvCell).join(',');
}

function guardarBreakdownCSV(rutaArchivo, header, bloques) {
    const lineas = [header];
    for (const blk of bloques) {
        const tot = sumarBloqueMapa(blk.mapa);
        lineas.push(filaBreakdownCSV(blk.nombre, tot));
        const entries = Object.entries(blk.mapa || {}).sort((a, b) => {
            const va = (a[1].Delivered || 0) + (a[1].SoftBounce || 0) + (a[1].HardBounce || 0);
            const vb = (b[1].Delivered || 0) + (b[1].SoftBounce || 0) + (b[1].HardBounce || 0);
            return vb - va || a[0].localeCompare(b[0]);
        });
        for (const [clave, metrics] of entries) {
            lineas.push(filaBreakdownCSV(clave, metrics));
        }
    }
    fs.mkdirSync(path.dirname(rutaArchivo), { recursive: true });
    fs.writeFileSync(rutaArchivo, '\uFEFF' + lineas.join('\r\n'), 'utf8');
}

async function main() {
    const { hoyCol, ayerCol } = obtenerAyerColombia();
    const fechaStr = (process.env.FECHA_MANUAL || '').trim() || ayerCol;
    console.log(`Hoy Colombia: ${hoyCol} | Extrayendo unicamente fecha: ${fechaStr}`);

    const [anioNum, mesNum, diaNum] = fechaStr.split('-').map(Number);
    const dia2 = String(diaNum).padStart(2, '0');
    const fechaCorta = `${MESES_CORTOS[mesNum - 1]}-${diaNum}`;
    const codeToBrand = cargarMapaCodigos(anioNum, mesNum);

    const webhookUrl = process.env.CLOUDFLARE_WEBHOOK_URL || process.env.GODADDY_WEBHOOK_URL;
    const gd = await obtenerEstadosCloudflare(webhookUrl, fechaStr)
        .catch(e => { console.error('Cloudflare D1:', e.message); return {}; });

    const mlj1Res = (process.env.MJ_KEY_1 && process.env.MJ_SECRET_1)
        ? await procesarMailjet('MLJ1', process.env.MJ_KEY_1, process.env.MJ_SECRET_1, fechaStr, codeToBrand).catch(e => { console.error('MLJ1:', e.message); return { porISP: nuevoMapaISPs(), porDominio: {}, porBrand: {} }; })
        : { porISP: nuevoMapaISPs(), porDominio: {}, porBrand: {} };
    const mlj2Res = (process.env.MJ_KEY_2 && process.env.MJ_SECRET_2)
        ? await procesarMailjet('MLJ2', process.env.MJ_KEY_2, process.env.MJ_SECRET_2, fechaStr, codeToBrand).catch(e => { console.error('MLJ2:', e.message); return { porISP: nuevoMapaISPs(), porDominio: {}, porBrand: {} }; })
        : { porISP: nuevoMapaISPs(), porDominio: {}, porBrand: {} };
    const mlj3Res = (process.env.MJ_KEY_3 && process.env.MJ_SECRET_3)
        ? await procesarMailjet('MLJ_SH', process.env.MJ_KEY_3, process.env.MJ_SECRET_3, fechaStr, codeToBrand).catch(e => { console.error('MLJ_SH:', e.message); return { porISP: nuevoMapaISPs(), porDominio: {}, porBrand: {} }; })
        : { porISP: nuevoMapaISPs(), porDominio: {}, porBrand: {} };

    const seg1 = process.env.SG_KEY_1
        ? await procesarSendgrid(process.env.SG_KEY_1, fechaStr).catch(e => { console.error('SEG1:', e.message); return { porISP: nuevoMapaISPs(), estados: {} }; })
        : { porISP: nuevoMapaISPs(), estados: {} };
    const seg2 = process.env.SG_KEY_2
        ? await procesarSendgrid(process.env.SG_KEY_2, fechaStr).catch(e => { console.error('SEG2:', e.message); return { porISP: nuevoMapaISPs(), estados: {} }; })
        : { porISP: nuevoMapaISPs(), estados: {} };

    // A) CSV diario por ISP (maildata)
    const lineas = [];
    lineas.push(',,,,,,,,,,,,,,,,');
    lineas.push(`,,,,,,,,,,,,,,,Date From:,${fechaCorta}`);
    lineas.push(`,,,,,,,,,,,,,,,Date To:,${fechaCorta}`);
    lineas.push(',,,,,,,,,,,,,,,← Change dates to refresh the report,');
    lineas.push('ESP,Domain,Delivered,Soft Bounce,Hard Bounce,Open,Open Rate,Click,Click-to-open Rate,Click Rate,Complaint,Unsubscribe/Blocked,Registration,Players,Throttling (emails per domain per hour),US States,');

    const grandTotal = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0, Complaint: 0, UnsubBlocked: 0 };
    const grandStates = {};

    function agregarBloque(tituloESP, subBloques, ordenISPs) {
        lineas.push(`${tituloESP},,,,,,,,,,,,,,,,`);
        for (const b of subBloques) {
            lineas.push(`${b.label},,,,,,,,,,,,,,,,`);
            for (const isp of ordenISPs) {
                lineas.push(filaCSV('', isp, b.porISP[isp]));
            }
            const tot = sumarBloque(b.porISP);
            for (const k of Object.keys(grandTotal)) grandTotal[k] += tot[k];
            for (const [st, cnt] of Object.entries(b.estados || {})) grandStates[st] = (grandStates[st] || 0) + cnt;
            lineas.push(filaCSV('', 'TOTAL', tot, formatEstados(b.estados)));
        }
        lineas.push(',,,,,,,,,,,,,,,,');
    }

    agregarBloque('MLJ (Mailjet)', [
        { label: 'IP 1', porISP: mlj1Res.porISP, estados: gd.MLJ1 || {} },
        { label: 'IP 2', porISP: mlj2Res.porISP, estados: gd.MLJ2 || {} },
        { label: 'IP 3 / SH', porISP: mlj3Res.porISP, estados: gd.MLJ_SH || {} },
    ], ISPS_MLJ);

    agregarBloque('SEG (Sendgrid)', [
        { label: 'IP 1', porISP: seg1.porISP, estados: seg1.estados },
        { label: 'IP 2 / SH', porISP: seg2.porISP, estados: seg2.estados },
    ], ISPS_SEG);

    lineas.push(filaCSV('GRAND TOTAL', '', grandTotal, formatEstados(grandStates)));

    const carpetaDestino = path.join(String(anioNum), 'maildata', `maildata_${MESES_CARPETA[mesNum - 1]}`);
    fs.mkdirSync(carpetaDestino, { recursive: true });
    const rutaArchivo = path.join(carpetaDestino, `${diaNum}.csv`);
    fs.writeFileSync(rutaArchivo, '\uFEFF' + lineas.join('\r\n'), 'utf8');
    console.log(`CSV de AYER guardado en: ${rutaArchivo}`);

    // B) CSVs Breakdown por Dominio y por Brand (en paralelo para SendGrid)
    const seg1Soft = sumarBloque(seg1.porISP).SoftBounce;
    const seg2Soft = sumarBloque(seg2.porISP).SoftBounce;

    const [segDom1, segDom2, segBrand1, segBrand2] = await Promise.all([
        process.env.SG_KEY_1
            ? procesarSendgridDominios('SEG1', process.env.SG_KEY_1, fechaStr).catch(e => { console.error('SEG1 Dominios:', e.message); return {}; })
            : Promise.resolve({}),
        process.env.SG_KEY_2
            ? procesarSendgridDominios('SEG2', process.env.SG_KEY_2, fechaStr).catch(e => { console.error('SEG2 Dominios:', e.message); return {}; })
            : Promise.resolve({}),
        process.env.SG_KEY_1
            ? procesarSendgridBrands('SEG1', process.env.SG_KEY_1, fechaStr, codeToBrand, seg1Soft).catch(e => { console.error('SEG1 Brands:', e.message); return {}; })
            : Promise.resolve({}),
        process.env.SG_KEY_2
            ? procesarSendgridBrands('SEG2', process.env.SG_KEY_2, fechaStr, codeToBrand, seg2Soft).catch(e => { console.error('SEG2 Brands:', e.message); return {}; })
            : Promise.resolve({})
    ]);

    const rutaBreakdownDom = path.join(String(anioNum), 'ESP - IP Breakdown', MESES_CARPETA_CAP[mesNum - 1], `${diaNum}.csv`);
    guardarBreakdownCSV(rutaBreakdownDom, 'ESP/Domain,VOLUME,Delivered,Soft Bounce,Hard Bounce,Opened,Clicks', [
        { nombre: 'MLJ (Mailjet) IP 1', mapa: mlj1Res.porDominio },
        { nombre: 'MLJ (Mailjet) IP 2', mapa: mlj2Res.porDominio },
        { nombre: 'MLJ (Mailjet) IP 3 / SH', mapa: mlj3Res.porDominio },
        { nombre: 'SEG (Sendgrid) IP 1', mapa: segDom1 },
        { nombre: 'SEG (Sendgrid) IP 2 / SH', mapa: segDom2 }
    ]);
    console.log(`CSV Breakdown por dominio guardado en: ${rutaBreakdownDom}`);

    const rutaBreakdownBrand = path.join(String(anioNum), 'ESP-Brand', MESES_CARPETA_CAP[mesNum - 1], `${dia2}.csv`);
    guardarBreakdownCSV(rutaBreakdownBrand, 'ESP/Brand,VOLUME,Delivered,Soft Bounce,Hard Bounce,Opened,Clicks', [
        { nombre: 'MLJ (Mailjet) IP 1', mapa: mlj1Res.porBrand },
        { nombre: 'MLJ (Mailjet) IP 2', mapa: mlj2Res.porBrand },
        { nombre: 'MLJ (Mailjet) IP 3 / SH', mapa: mlj3Res.porBrand },
        { nombre: 'SEG (Sendgrid) IP 1', mapa: segBrand1 },
        { nombre: 'SEG (Sendgrid) IP 2 / SH', mapa: segBrand2 }
    ]);
    console.log(`CSV Breakdown por Brand guardado en: ${rutaBreakdownBrand}`);
}

main();

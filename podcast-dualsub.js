/*!
 * Podcast DualSub: bilingual transcripts for Apple Podcasts
 *
 * Intercepts the TTML transcript the iOS Podcasts app downloads and inserts a
 * translation for every sentence, so the app's built-in Transcript view shows
 * the original and the translation side by side.
 *
 * Works with Quantumult X (also Surge / Loon / Stash / Shadowrocket).
 *
 * ---------------- Quantumult X ----------------
 * [rewrite_local]
 * ^https:\/\/podcasts\.itunes\.apple\.com\/itunes-assets\/.+\/transcript_\d+\.ttml url script-response-body https://raw.githubusercontent.com/illusion77/podcast-dualsub/main/podcast-dualsub.js
 *
 * [mitm]
 * hostname = podcasts.itunes.apple.com
 *
 * ---------------- Surge / Loon ----------------
 * Podcast DualSub = type=http-response, pattern=^https:\/\/podcasts\.itunes\.apple\.com\/itunes-assets\/.+\/transcript_\d+\.ttml, requires-body=1, max-size=0, timeout=30, script-path=https://raw.githubusercontent.com/illusion77/podcast-dualsub/main/podcast-dualsub.js
 *
 * ---------------- Options ----------------
 * Append #key=value&key=value to the script URL (Surge/Loon: use argument),
 * or store JSON under the persistent key podcast_dualsub, e.g. {"tl":"zh-TW","mode":"inline"}.
 *   tl          target language, default zh-CN (zh-TW / ja / ko ...)
 *   mode        stack  translation on its own line under each sentence (default)
 *               inline translation right after each sentence, paragraphs kept
 *               only   translation only
 *   timing      sentence translation spans the whole sentence; tapping it plays from
 *                        the start of the sentence (default)
 *               end      translation sits at the sentence end and never overlaps the
 *                        original word timings; use this if word highlighting misbehaves
 *   timeout     total translation budget in seconds, default 20; whatever is done
 *               by then is still inserted
 *   concurrency parallel requests, default 4
 *   notify      error (default, only on failure) / all / none
 */

const NAME = 'Podcast DualSub';
const STORE_KEY = 'podcast_dualsub';
const DEFAULTS = {
  tl: 'zh-CN',
  mode: 'stack',
  timing: 'sentence',
  timeout: 20,
  concurrency: 4,
  batchChars: 8000,
  batchSize: 200,
  notify: 'error',
};

const $ = env();
const opts = loadOptions();
const startedAt = Date.now();

main().catch(e => {
  $.log(`error: ${(e && e.stack) || e}`);
  if (opts.notify !== 'none') $.notify(NAME, 'Failed, original transcript returned', String((e && e.message) || e));
  $.done({});
});

async function main() {
  const body = $.body();
  if (!body || body.indexOf('<tt') < 0) return $.done({});

  const doc = parseTTML(body);
  const sl = (doc.lang || 'auto').toLowerCase();
  if (sl !== 'auto' && sameLang(sl, opts.tl)) return $.done({});
  if (doc.units.some(u => u.lang && sameLang(u.lang, opts.tl))) return $.done({}); // already translated

  const units = doc.units.filter(u => /[A-Za-z\u00C0-\u024F]/.test(u.text));
  if (!units.length) return $.done({});

  const stats = await translateAll(units, sl === 'auto' ? 'auto' : sl.split('-')[0], opts.tl);
  const done = units.filter(u => u.tr).length;
  if (!done) {
    if (opts.notify !== 'none') $.notify(NAME, 'Translation failed, original transcript returned', stats.error || `not finished within ${opts.timeout}s`);
    return $.done({});
  }

  const out = render(body, doc, opts.mode, opts.tl);
  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  const id = (($.url().match(/transcript_(\d+)/) || [])[1]) || '';
  $.log(`episode ${id}: translated ${done}/${units.length} sentences in ${secs}s, ${stats.requests} requests`);
  if (done < units.length && opts.notify !== 'none') {
    $.notify(NAME, `Partially translated (${done}/${units.length})`, stats.error || 'timed out, try a larger timeout');
  } else if (opts.notify === 'all') {
    $.notify(NAME, `Translated ${done} sentences`, `in ${secs}s`);
  }
  $.done({ body: out });
}

/* ---------------- TTML ---------------- */

// Apple's transcript layout: <p> (one speaker turn) > sentence span > word span.
// A <p> without sentence/word spans (generic TTML) is translated as one unit.
function parseTTML(xml) {
  const root = xml.match(/<tt\b[^>]*>/);
  const lang = root ? attr(root[0], 'xml:lang') : '';
  const paras = [];
  const units = [];
  const pRe = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = pRe.exec(xml))) {
    const p = { start: m.index, end: m.index + m[0].length, attrs: m[1], sentences: [], unit: null };
    const sRe = /<span\b([^>]*podcasts:unit="sentence"[^>]*)>((?:\s*<span\b[^>]*>[^<]*<\/span>)*\s*)<\/span>/g;
    let s;
    while ((s = sRe.exec(m[2]))) {
      const words = [];
      s[2].replace(/<span\b[^>]*>([^<]*)<\/span>/g, (_, w) => words.push(w));
      const unit = {
        raw: s[0],
        begin: attr(s[1], 'begin'),
        end: attr(s[1], 'end'),
        lang: attr(s[1], 'xml:lang'),
        text: decodeXML(words.join(' ')).replace(/\s+/g, ' ').trim(),
        tr: '',
      };
      p.sentences.push(unit);
      units.push(unit);
    }
    if (!p.sentences.length) {
      const text = decodeXML(m[2].replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
      if (text) {
        p.unit = { raw: m[2], begin: attr(m[1], 'begin'), end: attr(m[1], 'end'), lang: attr(m[1], 'xml:lang'), text, tr: '' };
        units.push(p.unit);
      }
    }
    paras.push(p);
  }
  return { lang, paras, units };
}

function render(xml, doc, mode, tl) {
  let out = '';
  let cursor = 0;
  for (const p of doc.paras) {
    out += xml.slice(cursor, p.start);
    out += renderPara(xml.slice(p.start, p.end), p, mode, tl);
    cursor = p.end;
  }
  return out + xml.slice(cursor);
}

function renderPara(orig, p, mode, tl) {
  const agent = attr(p.attrs, 'ttm:agent');
  const pOpen = (b, e) => `<p begin="${b}" end="${e}"${agent ? ` ttm:agent="${agent}"` : ''}>`;

  if (!p.sentences.length) {
    const u = p.unit;
    if (!u || !u.tr) return orig;
    const trP = `<p${p.attrs}>${escapeXML(u.tr)}</p>`;
    return mode === 'only' ? trP : orig + trP;
  }

  const trSpan = s => {
    const b = opts.timing === 'end' ? s.end : s.begin;
    return `<span begin="${b}" end="${s.end}" podcasts:unit="sentence" xml:lang="${tl}">` +
      `<span begin="${b}" end="${s.end}" podcasts:unit="word">${escapeXML(s.tr)}</span></span>`;
  };

  if (mode === 'inline' || mode === 'only') {
    let inner = orig.slice(orig.indexOf('>') + 1, orig.lastIndexOf('</p>'));
    for (const s of p.sentences) {
      if (!s.tr) continue;
      inner = inner.replace(s.raw, () => (mode === 'only' ? trSpan(s) : s.raw + trSpan(s)));
    }
    return `<p${p.attrs}>${inner}</p>`;
  }

  // stack: every sentence becomes its own line, followed by its translation
  let out = '';
  for (const s of p.sentences) {
    out += pOpen(s.begin, s.end) + s.raw + '</p>';
    if (s.tr) out += pOpen(s.begin, s.end) + trSpan(s) + '</p>';
  }
  return out;
}

/* ---------------- Translation ---------------- */

async function translateAll(units, sl, tl) {
  const batches = [];
  let cur = [];
  let chars = 0;
  for (const u of units) {
    if (cur.length && (chars + u.text.length > opts.batchChars || cur.length >= opts.batchSize)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(u);
    chars += u.text.length;
  }
  if (cur.length) batches.push(cur);

  const stats = { requests: 0, error: '' };
  const deadline = startedAt + opts.timeout * 1000;
  let next = 0;
  const worker = async () => {
    while (next < batches.length && Date.now() < deadline) {
      const batch = batches[next++];
      try {
        const res = await translateBatch(batch.map(u => u.text), sl, tl, stats);
        batch.forEach((u, i) => { u.tr = (res[i] || '').trim(); });
      } catch (e) {
        stats.error = String((e && e.message) || e);
        $.log(`batch failed: ${stats.error}`);
      }
    }
  };
  const workers = [];
  for (let i = 0; i < Math.min(opts.concurrency, batches.length); i++) workers.push(worker());
  let timer;
  const expired = new Promise(r => { timer = setTimeout(r, Math.max(0, deadline - Date.now())); });
  await Promise.race([Promise.all(workers), expired]);
  if (typeof clearTimeout === 'function') clearTimeout(timer); // QX only provides setTimeout
  return stats;
}

// Chrome's page-translation batch endpoint first, translate_a/t as fallback; each gets one retry.
async function translateBatch(texts, sl, tl, stats) {
  const engines = [googleHtml, googleGtx, googleHtml, googleGtx];
  let lastErr;
  for (const fn of engines) {
    try {
      stats.requests++;
      const res = await fn(texts, sl, tl);
      if (res.length === texts.length) return res;
      lastErr = new Error(`result count mismatch ${res.length}/${texts.length}`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function googleHtml(texts, sl, tl) {
  const resp = await $.fetch({
    url: 'https://translate-pa.googleapis.com/v1/translateHtml',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json+protobuf',
      'X-Goog-API-Key': 'AIzaSyATBXajvzQLTDHEQbcpq0Ihe0vWDHmO520',
    },
    body: JSON.stringify([[texts.map(escapeXML), sl, tl], 'te_lib']),
  });
  if (resp.status !== 200) throw new Error(`translateHtml HTTP ${resp.status}`);
  return JSON.parse(resp.body)[0].map(decodeXML);
}

async function googleGtx(texts, sl, tl) {
  const resp = await $.fetch({
    url: `https://translate.googleapis.com/translate_a/t?client=gtx&sl=${sl}&tl=${tl}&format=text`,
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: texts.map(t => 'q=' + encodeURIComponent(t)).join('&'),
  });
  if (resp.status !== 200) throw new Error(`translate_a HTTP ${resp.status}`);
  const data = JSON.parse(resp.body);
  return (Array.isArray(data) ? data : [data]).map(x => (Array.isArray(x) ? x[0] : x));
}

/* ---------------- Helpers ---------------- */

function attr(attrs, name) {
  const m = attrs.match(new RegExp(`\\s${name.replace(':', '\\:')}="([^"]*)"`));
  return m ? m[1] : '';
}

function escapeXML(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeXML(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, e) => {
    const k = e.toLowerCase();
    if (k[0] === '#') {
      const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      return isNaN(code) ? all : String.fromCodePoint(code);
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[k];
  });
}

function sameLang(a, b) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  return a === b || a.split('-')[0] === b.split('-')[0] && !/^zh/.test(a);
}

function loadOptions() {
  const o = Object.assign({}, DEFAULTS);
  try {
    const saved = $.read(STORE_KEY);
    if (saved) Object.assign(o, JSON.parse(saved));
  } catch (e) {
    $.log(`${STORE_KEY} is not valid JSON, ignored`);
  }
  Object.assign(o, $.args());
  for (const k of ['timeout', 'concurrency', 'batchChars', 'batchSize']) o[k] = Number(o[k]) || DEFAULTS[k];
  if (!/^(stack|inline|only)$/.test(o.mode)) o.mode = DEFAULTS.mode;
  if (!/^(sentence|end)$/.test(o.timing)) o.timing = DEFAULTS.timing;
  return o;
}

function env() {
  const isQX = typeof $task !== 'undefined';
  let finished = false;
  return {
    body() {
      if (typeof $response.body === 'string') return $response.body;
      if ($response.bodyBytes) return utf8Decode(new Uint8Array($response.bodyBytes));
      return '';
    },
    url() {
      return (typeof $request !== 'undefined' && $request.url) || '';
    },
    args() {
      let raw = {};
      if (typeof $environment !== 'undefined' && $environment.variables) raw = $environment.variables;
      else if (typeof $argument !== 'undefined' && $argument) raw = $argument;
      if (typeof raw === 'string') {
        raw = raw.split('&').reduce((acc, kv) => {
          const i = kv.indexOf('=');
          if (i > 0) acc[decodeURIComponent(kv.slice(0, i).trim())] = decodeURIComponent(kv.slice(i + 1).trim());
          return acc;
        }, {});
      }
      const out = {};
      for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined && raw[k] !== '') out[k] = raw[k];
      return out;
    },
    fetch(req) {
      if (isQX) {
        return $task.fetch(req).then(r => ({ status: r.statusCode, body: r.body }), e => Promise.reject(new Error((e && e.error) || String(e))));
      }
      return new Promise((resolve, reject) => {
        const method = (req.method || 'GET').toLowerCase();
        $httpClient[method]({ url: req.url, headers: req.headers, body: req.body, timeout: 15 }, (err, resp, data) => {
          if (err) reject(new Error(String(err)));
          else resolve({ status: resp.status || resp.statusCode, body: data });
        });
      });
    },
    read(key) {
      return isQX ? $prefs.valueForKey(key) : $persistentStore.read(key);
    },
    notify(title, sub, msg) {
      if (isQX) $notify(title, sub, msg);
      else $notification.post(title, sub, msg);
    },
    log(msg) {
      console.log(`[${NAME}] ${msg}`);
    },
    done(v) {
      if (finished) return;
      finished = true;
      if (v.body !== undefined && typeof $response.body !== 'string' && $response.bodyBytes) {
        $done({ bodyBytes: utf8Encode(v.body).buffer });
      } else {
        $done(v);
      }
    },
  };
}

function utf8Decode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i++];
    let c;
    if (b < 0x80) c = b;
    else if (b < 0xe0) c = ((b & 0x1f) << 6) | (bytes[i++] & 0x3f);
    else if (b < 0xf0) c = ((b & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    else c = ((b & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
    s += String.fromCodePoint(c);
  }
  return s;
}

function utf8Encode(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return new Uint8Array(out);
}

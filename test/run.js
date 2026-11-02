#!/usr/bin/env node
// Runs podcast-dualsub.js in Node inside a mocked Quantumult X script environment.
//
//   node test/run.js <file.ttml> [--mode stack|inline|only] [--tl zh-CN] [--timing sentence|end]
//                    [--offline] [--fail N] [--slow MS] [--timeout S] [--bytes] [--out out.ttml]
//
//   --offline  no network; each translation is "[tr] <original>"
//   --fail N   the first N translation requests return HTTP 500 (retry / fallback)
//   --slow MS  delay every translation request by MS ms (use with --timeout)
//   --bytes    hand the response over as bodyBytes (binary branch)
//   --prefs J  JSON stored under the podcast_dualsub key

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const args = process.argv.slice(2);
const BOOL_FLAGS = ['offline', 'bytes'];
const opts = {};
let file;
for (let i = 0; i < args.length; i++) {
  if (!args[i].startsWith('--')) file = args[i];
  else if (BOOL_FLAGS.includes(args[i].slice(2))) opts[args[i].slice(2)] = true;
  else opts[args[i].slice(2)] = args[++i];
}
const flag = name => opts[name] === true;
const opt = name => (opts[name] === true ? undefined : opts[name]);
if (!file) {
  console.error('usage: node test/run.js <file.ttml> [options]');
  process.exit(2);
}

const input = fs.readFileSync(file, 'utf8');
const variables = {};
for (const k of ['mode', 'tl', 'timing', 'timeout', 'concurrency', 'notify', 'batchChars']) if (opt(k)) variables[k] = opt(k);

let failLeft = Number(opt('fail') || 0);
const slow = Number(opt('slow') || 0);
const requests = [];
const notifications = [];

async function fakeFetch(req) {
  requests.push(req.url);
  if (slow) await new Promise(r => setTimeout(r, slow));
  if (failLeft > 0) {
    failLeft--;
    return { statusCode: 500, headers: {}, body: 'error' };
  }
  if (!flag('offline')) {
    const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    return { statusCode: r.status, headers: Object.fromEntries(r.headers), body: await r.text() };
  }
  if (req.url.includes('translateHtml')) {
    const [[texts]] = JSON.parse(req.body);
    return { statusCode: 200, headers: {}, body: JSON.stringify([texts.map(t => `[tr] ${t}`)]) };
  }
  const texts = req.body.split('&').map(kv => decodeURIComponent(kv.slice(2)));
  return { statusCode: 200, headers: {}, body: JSON.stringify(texts.map(t => `[tr] ${t}`)) };
}

const result = new Promise(resolve => {
  const bodyBytes = flag('bytes') ? new Uint8Array(Buffer.from(input, 'utf8')).buffer : undefined;
  const store = new Map();
  if (opt('prefs')) store.set('podcast_dualsub', opt('prefs'));
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    $request: { url: 'https://podcasts.itunes.apple.com/itunes-assets/PodcastContent221/v4/aa/bb/cc/x/transcript_1000798871712.ttml?accessKey=1', method: 'GET', headers: {} },
    $response: flag('bytes') ? { statusCode: 200, headers: {}, bodyBytes } : { statusCode: 200, headers: {}, body: input },
    $task: { fetch: fakeFetch },
    $prefs: { valueForKey: k => store.get(k), setValueForKey: (v, k) => store.set(k, v) },
    $notify: (t, s, m) => notifications.push([t, s, m].join(' | ')),
    $environment: { variables },
    $done: v => resolve(v),
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'podcast-dualsub.js'), 'utf8'), sandbox);
});

const t0 = Date.now();
result.then(v => {
  const ms = Date.now() - t0;
  let out = v.body;
  if (out === undefined && v.bodyBytes) out = Buffer.from(new Uint8Array(v.bodyBytes)).toString('utf8');
  console.log(`done in ${ms}ms, ${requests.length} requests, notifications: ${JSON.stringify(notifications)}`);
  if (out === undefined) {
    console.log('result: unchanged (original body returned)');
    return;
  }
  const outFile = opt('out') || path.join(require('os').tmpdir(), 'dualsub-out.ttml');
  fs.writeFileSync(outFile, out);
  try {
    execFileSync('xmllint', ['--noout', outFile], { stdio: 'pipe' });
    console.log('xmllint: well-formed');
  } catch (e) {
    console.log('xmllint FAILED:\n' + String(e.stderr).slice(0, 2000));
    process.exitCode = 1;
  }
  check(input, out);
  console.log(`written to ${outFile}`);
});

// Structure checks: every original word kept in order; translated sentences carry timings;
// report whether paragraph and word begin times stay non-decreasing.
function check(src, out) {
  const words = s => [...s.matchAll(/<span\b[^>]*podcasts:unit="word"[^>]*>([^<]*)<\/span>/g)];
  const lang = (variables.tl || 'zh-CN');
  const srcWords = words(src).map(m => m[1]);
  const outSents = [...out.matchAll(/<span\b([^>]*podcasts:unit="sentence"[^>]*)>/g)].map(m => m[1]);
  const trSents = outSents.filter(a => a.includes(`xml:lang="${lang}"`)).length;
  const keptWords = [];
  out.replace(/<span\b([^>]*podcasts:unit="sentence"[^>]*)>((?:<span\b[^>]*>[^<]*<\/span>)*)<\/span>/g, (all, a, inner) => {
    if (!a.includes(`xml:lang="${lang}"`)) for (const m of words(inner)) keptWords.push(m[1]);
  });
  const mode = variables.mode || 'stack';
  if (mode !== 'only') {
    const same = keptWords.length === srcWords.length && keptWords.every((w, i) => w === srcWords[i]);
    console.log(`original words preserved: ${same ? 'yes' : 'NO'} (${keptWords.length}/${srcWords.length})`);
    if (!same) process.exitCode = 1;
  }
  const t = s => s.split(':').reduce((acc, x) => acc * 60 + parseFloat(x), 0);
  const pBegins = [...out.matchAll(/<p\b[^>]*\bbegin="([^"]+)"/g)].map(m => t(m[1]));
  const monotonic = pBegins.every((b, i) => i === 0 || b >= pBegins[i - 1]);
  const wBegins = [...out.matchAll(/<span\b[^>]*\bbegin="([^"]+)"[^>]*podcasts:unit="word"/g)].map(m => t(m[1]));
  const wordsMonotonic = wBegins.every((b, i) => i === 0 || b >= wBegins[i - 1]);
  console.log(`paragraphs: ${(src.match(/<p\b/g) || []).length} -> ${pBegins.length}, translated sentences: ${trSents}/${outSents.length - trSents}, p.begin monotonic: ${monotonic}, word.begin monotonic: ${wordsMonotonic}`);
  const sample = out.match(new RegExp(`xml:lang="${lang}"><span[^>]*>([^<]*)<`, 'g')) || [];
  console.log('samples:', sample.slice(0, 3).map(s => s.replace(/.*>([^<]*)<$/, '$1')));
}

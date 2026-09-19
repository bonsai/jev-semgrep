#!/usr/bin/env node
// semgrep: jev (TypeSafe System One) で「意味的に」マッチする行を探す grep。
//   semgrep -e "network failure" -a "already retried" -e "customer wants a refund" FILE...
//   -e は OR で並び、-a / -v は直前の -e 項に AND / AND NOT で連結する。(A and B and not C) or D。
//   意味の先頭に ! を付けるとその意味だけ否定できる。-e A -e '!B' は A or not B。
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';

// エラーは grep と同じく 1 行 + 終了コード 2。スタックトレースは出さない。
const die = msg => { console.error(`semgrep: ${msg}\nTry 'semgrep --help' for more information.`); process.exit(2); };
process.on('uncaughtException', e => die(e.message));

// 裸の --color は --color=auto と同じ (grep と同様)。parseArgs は値なしを扱えないので先に補う。
const argv = process.argv.slice(2).map(a => (a === '--color' ? '--color=auto' : a));
const { values: opt, positionals: files, tokens } = parseArgs({
  args: argv,
  allowPositionals: true,
  tokens: true,
  options: {
    e: { type: 'string', multiple: true },
    a: { type: 'string', multiple: true },
    v: { type: 'string', multiple: true },
    level: { type: 'string', default: 'normal' }, // 厳しさのプリセット: loose / normal / strict
    r: { type: 'boolean', default: false }, // ディレクトリを再帰
    l: { type: 'boolean', default: false }, // 一致したファイル名だけ
    t: { type: 'string' }, // 肯定の閾値: p >= t で一致 (既定はプリセット)
    T: { type: 'string' }, // 否定の閾値: p < T で「〜でない」と判定 (既定はプリセット)
    c: { type: 'string', default: '30' }, // 1リクエストあたりの行数
    j: { type: 'string', default: '8' }, // 並列リクエスト数
    A: { type: 'string' }, // 一致行の後ろ N 行
    B: { type: 'string' }, // 一致行の前 N 行
    C: { type: 'string' }, // 前後 N 行
    n: { type: 'boolean', default: false }, // 行番号
    p: { type: 'boolean', default: false }, // 各意味の確率を表示
    color: { type: 'string', default: 'auto' }, // auto / always / never
    help: { type: 'boolean', short: 'h', default: false },
  },
});
if (opt.help) {
  console.log(`usage: semgrep [OPTION]... -e MEANING [-a MEANING] [-v MEANING]... [FILE...]
jev (TypeSafe System One) で意味的にマッチする行を探す grep。FILE 省略時は stdin。

  -e MEANING   この意味に合う行 (複数指定は OR)
  -a MEANING   直前の -e 項に AND で連結。-e A -a B -e C は (A and B) or C
  -v MEANING   直前の -e 項に AND NOT で連結。-e A -v B は A and not B
               先頭に置けば単独の否定。-v B は not B (grep -v 相当)
  !MEANING     -e / -a / -v のどこでも、先頭に ! を付けるとその意味だけ否定
               -e A -e '!B' は A or not B。-a '!C' は -v C と同じ
  --level=LEVEL 厳しさ。肯定と否定の閾値をまとめて決める (既定 normal)
                 loose  : -t 0.3 -T 0.7  多少あやしくても拾う
                 normal : -t 0.5 -T 0.5
                 strict : -t 0.7 -T 0.3  確信のある行だけ拾う
  -t THRESH    肯定条件の閾値。確率 >= THRESH で一致 (--level より優先)
  -T THRESH    否定条件の閾値。確率 < THRESH で「〜でない」と判定 (--level より優先)
               -t 0.6 -T 0.3 なら 0.3〜0.6 の曖昧な行はどちらにも当たらない
  -r           ディレクトリを再帰的に探す (FILE 省略時はカレント)。.git と node_modules、
               バイナリファイルは飛ばす
  -l           一致した行ではなくファイル名だけを表示
  -A NUM       一致行の後ろ NUM 行も表示 (grep と同じ。文脈行の区切りは - )
  -B NUM       一致行の前 NUM 行も表示
  -C NUM       前後 NUM 行を表示 (-A NUM -B NUM)
  -c LINES     1 リクエストにまとめる行数 (既定 30)
  -j N         同時リクエスト数 (既定 8)
  -n           行番号を付ける
  -p           各意味の確率を行末に表示 (閾値調整用)
  --color[=WHEN] 色付け。auto (端末なら付ける、既定) / always / never。=WHEN 省略時は auto
               ファイル名・行番号は grep と同じ配色。-p の確率は閾値以上を緑、
               否定側の閾値未満を赤、あいだを黄で表示。NO_COLOR にも従う
  -h, --help   このヘルプ

終了コード: 一致あり 0 / なし 1 / 引数エラー 2

API キーの設定 (TypeSafe / Jev):
  https://console.typesafe.ai/ でキーを取得し、次のいずれかで渡す。上から順に探す。
    export TYPESAFE_API_KEY=your-key                         環境変数
    SEMGREP_ENV=/path/to/.env semgrep ...                    任意の .env ファイル
    ./.env                                                   カレントディレクトリ (プロジェクト単位)
    ~/.config/semgrep/.env                                   ユーザー単位
  .env の中身は 1 行:  TYPESAFE_API_KEY=your-key
  例:  mkdir -p ~/.config/semgrep && echo 'TYPESAFE_API_KEY=your-key' > ~/.config/semgrep/.env`);
  process.exit(0);
}

// API キー: 環境変数になければ .env ファイルを順に探す
if (!process.env.TYPESAFE_API_KEY) {
  const candidates = [process.env.SEMGREP_ENV, '.env', `${homedir()}/.config/semgrep/.env`];
  const found = candidates.find(f => f && existsSync(f));
  if (found) process.loadEnvFile(found);
}
const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) die('TYPESAFE_API_KEY is not set. Put it in ./.env or ~/.config/semgrep/.env');

// 式: OR で並ぶ AND 項のリスト。項の要素は [意味の番号, 否定か]。meanings は重複なしの全意味。
const expr = [];
const meanings = [];
for (const tk of tokens) {
  if (tk.kind !== 'option' || !['e', 'a', 'v'].includes(tk.name)) continue;
  if (tk.name === 'a' && expr.length === 0) die('-a needs a preceding -e');
  const not = tk.value.startsWith('!'); // 個別の否定: "!MEANING"
  const text = not ? tk.value.slice(1) : tk.value;
  let m = meanings.indexOf(text);
  if (m < 0) m = meanings.push(text) - 1;
  const lit = [m, not !== (tk.name === 'v')];
  if (tk.name === 'e' || expr.length === 0) expr.push([lit]);
  else expr.at(-1).push(lit);
}
if (!meanings.length) die('no -e MEANING given');
const levels = { loose: [0.3, 0.7], normal: [0.5, 0.5], strict: [0.7, 0.3] };
const level = levels[opt.level];
if (!level) die(`--level must be one of ${Object.keys(levels).join(', ')}`);
const tPos = opt.t === undefined ? level[0] : Number(opt.t);
const tNeg = opt.T === undefined ? level[1] : Number(opt.T);
const chunkLines = Number(opt.c);

// -r ならディレクトリを展開する。.git / node_modules とバイナリ (先頭 8KB に NUL) は飛ばす。
function expand(path) {
  if (!statSync(path).isDirectory()) return [path];
  if (!opt.r) die(`${path}: Is a directory (use -r)`);
  return readdirSync(path, { withFileTypes: true })
    .filter(d => !['.git', 'node_modules'].includes(d.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(d => expand(join(path, d.name)));
}
const targets = (files.length ? files : [opt.r ? '.' : '-']).flatMap(f => (f === '-' ? [f] : expand(f)));
const sources = new Map(); // file -> 全行 (文脈表示用。空行も含む)
const lines = []; // { file, no, text }  空行は API に送らない
for (const file of targets) {
  const buf = readFileSync(file === '-' ? 0 : file);
  if (buf.subarray(0, 8192).includes(0)) continue;
  const src = buf.toString('utf8').split('\n');
  if (src.at(-1) === '') src.pop();
  sources.set(file, src);
  src.forEach((text, i) => text.trim() && lines.push({ file, no: i + 1, text }));
}

// 行数と文字数の両方で区切る。state+最長質問は 32k トークンが上限。
const chunks = [];
for (let i = 0; i < lines.length; ) {
  const chunk = [];
  let chars = 0;
  while (i < lines.length && chunk.length < chunkLines && chars < 20000) {
    chars += lines[i].text.length;
    chunk.push(lines[i++]);
  }
  chunks.push(chunk);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
let usedTokens = 0;

async function evaluate(chunk) {
  const id = i => `L${String(i).padStart(3, '0')}`;
  const state = Object.fromEntries(chunk.map((l, i) => [id(i), l.text.slice(0, 2000)]));
  const questions = {};
  chunk.forEach((_, i) => meanings.forEach((text, m) => {
    questions[`${id(i)}_${m}`] = { type: 'noul', instructions: `Does line ${id(i)} match the meaning: "${text}"?` };
  }));
  for (let attempt = 0; ; attempt++) {
    const res = await fetch('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state, questions }),
    });
    if ((res.status === 429 || res.status === 529) && attempt < 6) {
      await sleep(500 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new Error(`typesafe ${res.status}: ${await res.text()}`);
    const { answers, usage } = await res.json();
    usedTokens += usage.input_tokens;
    return chunk.map((_, i) => meanings.map((_, m) => answers[`${id(i)}_${m}`].noul));
  }
}

// -j 本まで同時に投げ、結果はチャンク順に出力する。
let running = 0;
const waiters = [];
const acquire = () => (running++ < Number(opt.j) ? Promise.resolve() : new Promise(r => waiters.push(r)));
const release = () => (running--, waiters.shift()?.());
const results = chunks.map(async chunk => {
  await acquire();
  try { return await evaluate(chunk); } finally { release(); }
});

const color = opt.color === 'always' || (opt.color === 'auto' && process.stdout.isTTY && !process.env.NO_COLOR);
if (!['auto', 'always', 'never'].includes(opt.color)) die('--color must be auto, always or never');
const paint = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const paintProb = x => paint(x >= tPos ? 32 : x < tNeg ? 31 : 33, x.toFixed(2));

// 一致行を file -> (行番号 -> 確率) に集めてから、ファイル順・行順に文脈つきで出力する。
const hits = new Map();
let matched = 0;
for (const [ci, result] of results.entries()) {
  const probs = await result;
  chunks[ci].forEach((l, i) => {
    const p = probs[i];
    if (!expr.some(term => term.every(([m, not]) => (not ? p[m] < tNeg : p[m] >= tPos)))) return;
    matched++;
    if (!hits.has(l.file)) hits.set(l.file, new Map());
    hits.get(l.file).set(l.no, p);
  });
}

const after = Number(opt.A ?? opt.C ?? 0), before = Number(opt.B ?? opt.C ?? 0);
const multi = targets.length > 1;
let lastPrinted = null; // [file, 行番号]。文脈グループの切れ目に -- を出すため
for (const file of targets) {
  const h = hits.get(file);
  if (!h) continue;
  if (opt.l) { console.log(paint(35, file)); continue; }
  const src = sources.get(file);
  let last = 0; // このファイルで出力済みの最終行番号
  for (const no of [...h.keys()].sort((a, b) => a - b)) {
    const from = Math.max(no - before, last + 1), to = Math.min(no + after, src.length);
    if ((after || before) && lastPrinted && (lastPrinted[0] !== file || from > last + 1)) console.log(paint(36, '--'));
    for (let k = from; k <= to; k++) {
      const p = h.get(k);
      const sep = paint(36, p ? ':' : '-');
      const prefix = (multi ? paint(35, file) + sep : '') + (opt.n ? paint(32, k) + sep : '');
      const tail = opt.p && p ? `\t[${p.map(paintProb).join(' ')}]` : '';
      console.log(prefix + src[k - 1] + tail);
    }
    last = Math.max(last, to);
    lastPrinted = [file, to];
  }
}
console.error(`${matched}/${lines.length} lines, ${chunks.length} requests, ${usedTokens} input tokens`);
process.exit(matched ? 0 : 1);

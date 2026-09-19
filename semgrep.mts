#!/usr/bin/env node
// semgrep: jev (TypeSafe System One) で「意味的に」マッチする行を探す grep。
//   semgrep -e "network failure" -a "already retried" -e "customer wants a refund" FILE...
//   -e は OR で並び、-a / -v は直前の -e 項に AND / AND NOT で連結する。(A and B and not C) or D。
//   意味の先頭に ! を付けるとその意味だけ否定できる。-e A -e '!B' は A or not B。
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error('TYPESAFE_API_KEY is not set (--env-file?)');

const { values: opt, positionals: files, tokens } = parseArgs({
  allowPositionals: true,
  tokens: true,
  options: {
    e: { type: 'string', multiple: true },
    a: { type: 'string', multiple: true },
    v: { type: 'string', multiple: true },
    l: { type: 'string', default: 'normal' }, // 厳しさのプリセット: loose / normal / strict
    t: { type: 'string' }, // 肯定の閾値: p >= t で一致 (既定はプリセット)
    T: { type: 'string' }, // 否定の閾値: p < T で「〜でない」と判定 (既定はプリセット)
    c: { type: 'string', default: '30' }, // 1リクエストあたりの行数
    j: { type: 'string', default: '8' }, // 並列リクエスト数
    n: { type: 'boolean', default: false }, // 行番号
    p: { type: 'boolean', default: false }, // 各意味の確率を表示
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
  -l LEVEL     厳しさ。肯定と否定の閾値をまとめて決める (既定 normal)
                 loose  : -t 0.3 -T 0.7  多少あやしくても拾う
                 normal : -t 0.5 -T 0.5
                 strict : -t 0.7 -T 0.3  確信のある行だけ拾う
  -t THRESH    肯定条件の閾値。確率 >= THRESH で一致 (-l より優先)
  -T THRESH    否定条件の閾値。確率 < THRESH で「〜でない」と判定 (-l より優先)
               -t 0.6 -T 0.3 なら 0.3〜0.6 の曖昧な行はどちらにも当たらない
  -c LINES     1 リクエストにまとめる行数 (既定 30)
  -j N         同時リクエスト数 (既定 8)
  -n           行番号を付ける
  -p           各意味の確率を行末に表示 (閾値調整用)
  -h, --help   このヘルプ

終了コード: 一致あり 0 / なし 1 / 引数エラー 2
環境変数: TYPESAFE_API_KEY (ラッパー semgrep は .env / SEMGREP_ENV から読む)`);
  process.exit(0);
}

// 式: OR で並ぶ AND 項のリスト。項の要素は [意味の番号, 否定か]。meanings は重複なしの全意味。
const expr: [number, boolean][][] = [];
const meanings: string[] = [];
for (const tk of tokens) {
  if (tk.kind !== 'option' || !['e', 'a', 'v'].includes(tk.name)) continue;
  if (tk.name === 'a' && expr.length === 0) throw new Error('-a needs a preceding -e');
  const not = tk.value!.startsWith('!'); // 個別の否定: "!MEANING"
  const text = not ? tk.value!.slice(1) : tk.value!;
  let m = meanings.indexOf(text);
  if (m < 0) m = meanings.push(text) - 1;
  const lit: [number, boolean] = [m, not !== (tk.name === 'v')];
  if (tk.name === 'e' || expr.length === 0) expr.push([lit]);
  else expr.at(-1)!.push(lit);
}
if (!meanings.length) throw new Error('no -e/-v MEANING given');
const levels: Record<string, [number, number]> = { loose: [0.3, 0.7], normal: [0.5, 0.5], strict: [0.7, 0.3] };
const level = levels[opt.l!];
if (!level) throw new Error(`-l must be one of ${Object.keys(levels).join(', ')}`);
const tPos = opt.t === undefined ? level[0] : Number(opt.t);
const tNeg = opt.T === undefined ? level[1] : Number(opt.T);
const chunkLines = Number(opt.c);

type Line = { file: string; no: number; text: string };
const lines: Line[] = [];
for (const file of files.length ? files : ['-']) {
  const src = readFileSync(file === '-' ? 0 : file, 'utf8').split('\n');
  if (src.at(-1) === '') src.pop();
  src.forEach((text, i) => text.trim() && lines.push({ file, no: i + 1, text }));
}

// 行数と文字数の両方で区切る。state+最長質問は 32k トークンが上限。
const chunks: Line[][] = [];
for (let i = 0; i < lines.length; ) {
  const chunk: Line[] = [];
  let chars = 0;
  while (i < lines.length && chunk.length < chunkLines && chars < 20000) {
    chars += lines[i].text.length;
    chunk.push(lines[i++]);
  }
  chunks.push(chunk);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
let usedTokens = 0;

async function evaluate(chunk: Line[]): Promise<number[][]> {
  const id = (i: number) => `L${String(i).padStart(3, '0')}`;
  const state = Object.fromEntries(chunk.map((l, i) => [id(i), l.text.slice(0, 2000)]));
  const questions: Record<string, unknown> = {};
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
    return chunk.map((_, i) => meanings.map((_, m) => answers[`${id(i)}_${m}`].noul as number));
  }
}

// -j 本まで同時に投げ、結果はチャンク順に出力する。
let running = 0;
const waiters: (() => void)[] = [];
const acquire = () => (running++ < Number(opt.j) ? Promise.resolve() : new Promise<void>(r => waiters.push(r)));
const release = () => (running--, waiters.shift()?.());
const results = chunks.map(async chunk => {
  await acquire();
  try { return await evaluate(chunk); } finally { release(); }
});

const multi = files.length > 1;
let matched = 0;
for (const [ci, result] of results.entries()) {
  const probs = await result;
  chunks[ci].forEach((l, i) => {
    const p = probs[i];
    if (!expr.some(term => term.every(([m, not]) => (not ? p[m] < tNeg : p[m] >= tPos)))) return;
    matched++;
    const prefix = (multi ? `${l.file}:` : '') + (opt.n ? `${l.no}:` : '');
    const tail = opt.p ? `\t[${p.map(x => x.toFixed(2)).join(' ')}]` : '';
    console.log(prefix + l.text + tail);
  });
}
console.error(`${matched}/${lines.length} lines, ${chunks.length} requests, ${usedTokens} input tokens`);
process.exit(matched ? 0 : 1);

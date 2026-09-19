# semgrep — 意味で探す grep

[English version](README.md)

正規表現ではなく **意味** で行を探す grep です。
判定には [TypeSafe AI](https://typesafe.ai/) の System One モデル **Jev** を使います。
Jev は文章を生成せず、typed な質問に確率だけを返すモデルなので、1 行ごとに
「この行は『ネットワーク障害』の意味に合うか」と聞き、返ってきた確率を閾値で切ります。

```sh
./semgrep -n -e "顧客が怒っている、または不満を持っている" tickets.txt
```

- 依存ゼロ。Node.js 23.6 以降（`.mts` の型剥がし）と `fetch` だけで動きます。
- 速い。30 行を 1 リクエストにまとめ、8 本並列で投げます。210 行のファイルが 1 秒弱で終わります。
- 意味は AND / OR / NOT で自由に組み合わせられます。
- **言語をまたげる。** 日本語で書いた意味で英語の行が、英語で書いた意味で日本語の行が見つかります。翻訳は挟まず、速度も費用も同じです。

## 言語をまたいで探せる

意味と本文の言語が違っていても構いません。Jev は語ではなく概念を照合するので、
1 つの問い合わせでファイル中のあらゆる言語の行が対象になります。

**英語**の意味で**日本語**の行が見つかります。どの行にも angry / frustrated の語はなく、うち 2 行は日本語です。

```sh
$ ./semgrep -n -e "customer is angry or frustrated" tests/corpus.txt
14:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた
16:ユーザー佐藤さんからの問い合わせ: 注文した覚えのない請求が来ています。至急確認してください
18:I want my money back. The item arrived broken and customer service ignored me.
21:Your product ruined my weekend. Never buying from you again.
23:This is the third time I'm writing. Nobody has replied to my previous emails.
```

**日本語**の意味で**英語**の行が、日本語の行と同じ確信度で見つかります。

```sh
$ ./semgrep -n -p -e "返金の要求" tests/corpus.txt
14:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた	[0.97]
18:I want my money back. The item arrived broken and customer service ignored me.	[0.95]
```

日英が混ざったログや問い合わせのダンプ、メンバーごとに問い合わせの言語が違うチームで効きます。
注意点が 1 つあります。TypeSafe は英語の精度が最も高いと明記しており、手元の実測でも日本語の意味は
閾値付近でややぶれます。際どい問い合わせは英語で書く方が安定します。

## インストール

必要なものは Node.js 23.6 以降（`node --version` で確認）と、
[TypeSafe のコンソール](https://console.typesafe.ai/) で取得した API キーだけです。`npm install` は不要です。

```sh
git clone https://github.com/uehaj/jev-semgrep.git
cd jev-semgrep
echo 'TYPESAFE_API_KEY=your-key' > .env
chmod +x semgrep
ln -s "$PWD/semgrep" ~/.local/bin/semgrep    # PATH の通った任意のディレクトリでよい
semgrep --help
```

ラッパーはシンボリックリンクの先のディレクトリにある `.env` を読むので、どこから呼んでも動きます。
キーを別の場所に置くなら `SEMGREP_ENV=/path/to/.env`、または `TYPESAFE_API_KEY` を export して `.env` を省いても構いません。
`.env` は git 管理外です。

更新は `git -C /path/to/jev-semgrep pull` です。

> 静的解析ツールの [Semgrep](https://semgrep.dev/) と同名です。両方使うならどちらかを別名にしてください。

## 例

例はすべて [`tests/corpus.txt`](tests/corpus.txt) に対するものです。サーバログ、日英の問い合わせ、
ソースコード、SQL、雑談が混ざった 51 行のファイルです。

### 概念で探す。言語は問わない

```sh
$ ./semgrep -n -e "customer is angry or frustrated" tests/corpus.txt
14:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた
16:ユーザー佐藤さんからの問い合わせ: 注文した覚えのない請求が来ています。至急確認してください
18:I want my money back. The item arrived broken and customer service ignored me.
21:Your product ruined my weekend. Never buying from you again.
23:This is the third time I'm writing. Nobody has replied to my previous emails.
5/51 lines, 2 requests, 3225 input tokens
```

どの行にも「angry」「frustrated」という語はありません。英語の意味で日本語の行も拾えています。

### OR で 2 つの意味。`-p` で確率も見る

```sh
$ ./semgrep -n -p -e "返金の要求" -e "配送先の変更依頼" tests/corpus.txt
14:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた	[0.97 0.02]
17:ユーザー高橋さんからの問い合わせ: 配送先の住所を変更したいのですが	[0.01 0.96]
18:I want my money back. The item arrived broken and customer service ignored me.	[0.96 0.01]
22:Can I change the delivery address for order #8821?	[0.02 0.96]
4/51 lines, 2 requests, 4602 input tokens
```

末尾の括弧が、指定した順に各意味の確率です。閾値を決めるときの目安になります。

### AND NOT。ネットワーク障害のうちリトライ中のものを除く

```sh
$ ./semgrep -n -e "ネットワークやリモート接続の障害" -v "a retry is happening or was attempted" tests/corpus.txt
4:2026-09-19 08:02:30 ERROR connection reset by peer while calling payment-gateway
6:2026-09-19 08:02:35 ERROR timeout after 5000ms waiting for payment-gateway
9:2026-09-19 08:10:44 ERROR DNS lookup failed for api.example.com
11:2026-09-19 09:00:00 ERROR SSL handshake failed: certificate expired
13:network unreachable: no route to host 10.0.0.5
30:except ConnectionError as e:
31:    logger.error("upstream unreachable: %s", e)
7/51 lines, 2 requests, 5112 input tokens
```

5 行目の `retrying payment-gateway request (attempt 2/3)` はネットワーク障害ですが、`-v` で落ちています。

### 混合。(金融 AND 悪いニュース) OR 天気

```sh
$ ./semgrep -n -e "about economy, finance or markets" -a "the news is negative or a decline" -e "about weather" tests/corpus.txt
36:今日の天気は晴れ、最高気温は28度です
43:Stock prices fell 3% after the earnings report missed expectations.
48:明日は雨の予報なので傘を持っていきます
3/51 lines, 2 requests, 5673 input tokens
```

`The central bank raised interest rates` は金融の話ですが下落ではないので外れています。

### 厳しさのプリセット

```sh
$ ./semgrep -l strict -n -e "a security risk or dangerous destructive operation" tests/corpus.txt
33:DROP TABLE sessions;
49:API keys must never be committed to the repository.

$ ./semgrep -l loose -n -e "a security risk or dangerous destructive operation" tests/corpus.txt
11:2026-09-19 09:00:00 ERROR SSL handshake failed: certificate expired
16:ユーザー佐藤さんからの問い合わせ: 注文した覚えのない請求が来ています。至急確認してください
33:DROP TABLE sessions;
49:API keys must never be committed to the repository.
```

`strict` はモデルが確信している行だけ、`loose` は期限切れ証明書や身に覚えのない請求まで拾います。

### 「〜でない」行を全部

```sh
./semgrep -v "a timestamped server log line" mixed.txt   # grep -v 相当
./semgrep -e "source code or SQL" -v "SQL" src.txt       # コードだが SQL ではない
cat app.log | ./semgrep -e "デプロイが失敗した、またはロールバックされた"
```

## 使い方

```
usage: semgrep [OPTION]... -e MEANING [-a MEANING] [-v MEANING]... [FILE...]

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
```

FILE を省略すると stdin を読みます。複数ファイルなら `file:` を前置きします。
終了コードは grep と同じで、一致あり 0、なし 1、引数エラー 2 です。

### 式の書き方

`-e` が OR の項を始め、`-a` / `-v` は直前の項に AND / AND NOT で連結します。
意味の先頭に `!` を付けるとその意味だけを否定できます（シェルの履歴展開を避けるためシングルクォートで囲んでください）。

| コマンド | 意味 |
|---|---|
| `-e A -e B` | A or B |
| `-e A -a B` | A and B |
| `-e A -v B` | A and not B |
| `-e A -a B -v C -e D` | (A and B and not C) or D |
| `-e A -e '!B'` | A or not B |
| `-v B` | not B |

## 仕組み

1. 空行を除いた行を 30 行ずつ（文字数上限つき）のチャンクに分ける
2. チャンクを `{"L000": "行1", "L001": "行2", ...}` という object として `state` に入れ、
   行 × 意味 の数だけ `noul`（yes/no 確率）質問を 1 リクエストにまとめて送る
3. 8 本まで並列にリクエストし、結果はファイル順に出力する
4. 各行について、意味ごとの確率を閾値で真偽に変え、AND / OR / NOT の式を評価する

行をまとめても、1 行ずつ送った場合と確率はほぼ変わりません（30 行で 1 リクエスト約 0.2 秒、
1 行ずつだと約 7 秒）。チャンクを大きくしすぎると閾値付近の行が落ちやすくなるので既定は 30 行です。
確率は実行ごとに ±0.05 ほどぶれます。閾値を詰めるときは `-p` で確率を見てください。

料金は入力 100 万トークンあたり 0.042 ドル（2026 年 9 月時点）で、2 つの意味で 30 行のチャンクが
約 3,000 トークンです。上限はレート制限（1,200 リクエスト/分）で決まり、既定設定なら毎分およそ
36,000 行です。

## テスト

`tests/` に LLM-as-judge のテストがあります。`tests/corpus.txt`（51 行）に対して `tests/cases.json` の
10 ケースを実行し、Claude（`claude -p`）が「各意味に本当に合致する行」を判定した結果と突き合わせて
precision / recall を出します。あわせて `-t` × `-T` を 0.05 刻みで総当たりし、最良の閾値を報告します。

```sh
node --no-warnings tests/judge.mts [--model sonnet] [--rejudge]
```

ジャッジの判定は `tests/verdicts.json` にキャッシュされ、2 回目以降はジャッジを呼びません。
結果は `tests/report.md` に書き出されます。直近の結果は precision 0.94、recall 0.98 です。

## 制約

- 1 行は 2,000 文字で切って送ります。
- 1 リクエストの質問数上限は公式に書かれていませんが、420 質問は通っています。
- 429 / 529 は指数バックオフで 6 回まで再試行します。
- 精度は英語がもっとも高く、日本語も使えますがぶれは大きめです。

## ライセンス

MIT

# semgrep — 意味で探す grep

テキストファイルから、正規表現ではなく **意味** でマッチする行を探す grep です。
判定には [TypeSafe AI](https://typesafe.ai/) の System One モデル **Jev** を使います。
Jev は文章を生成せず、typed な質問に確率だけを返すモデルなので、1 行ごとに
「この行は『ネットワーク障害』の意味に合うか」という yes/no 質問を投げ、確率を閾値で切ります。

```sh
./semgrep -n -e "ネットワークやリモート接続の障害" -v "リトライ中" app.log
```

- 依存ゼロ。Node.js 23.6 以降（`.mts` の型剥がし）と `fetch` だけで動きます。
- 30 行を 1 リクエストにまとめて並列で投げるので、210 行のファイルが 1 秒弱で終わります。
- 意味は AND / OR / NOT で自由に組み合わせられます。
- 日本語の意味で英語の行を探す、その逆も可能です。

## セットアップ

1. [TypeSafe のコンソール](https://console.typesafe.ai/) で API キーを取得する
2. このディレクトリに `.env` を置く

   ```
   TYPESAFE_API_KEY=your-key
   ```

   `SEMGREP_ENV=/path/to/.env` で場所を変えられます。環境変数 `TYPESAFE_API_KEY` を直接 export しても構いません。
3. `chmod +x semgrep` して PATH の通った場所にシンボリックリンクを張る

> 静的解析ツールの [Semgrep](https://semgrep.dev/) と同名です。両方入れる場合はどちらかを別名にしてください。

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
意味の先頭に `!` を付けると、その意味だけを否定できます（シェルの履歴展開を避けるためシングルクォートで囲んでください）。

| コマンド | 意味 |
|---|---|
| `-e A -e B` | A or B |
| `-e A -a B` | A and B |
| `-e A -v B` | A and not B |
| `-e A -a B -v C -e D` | (A and B and not C) or D |
| `-e A -e '!B'` | A or not B |
| `-v B` | not B |

### 例

```sh
# 怒っている顧客の問い合わせ
./semgrep -e "customer is angry or frustrated" tickets.txt

# ネットワーク障害のうち、リトライで済んでいないもの
./semgrep -n -e "ネットワークやリモート接続の障害" -v "a retry is happening" app.log

# 返金要求 または 配送先変更。確率も表示して閾値を検討する
./semgrep -p -e "返金の要求" -e "配送先の変更依頼" tickets.txt

# タイムスタンプ付きログ以外の行
./semgrep -v "a timestamped server log line" mixed.txt

# 取りこぼしを減らしたい
./semgrep -l loose -e "セキュリティ上のリスク" *.log
```

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

---
name: semgrep
description: 意味で行を探す grep（@uehaj/semgrep）でファイルやディレクトリを探索し、該当行を示す。/semgrep <探したい意味> [対象ファイル・ディレクトリ]
disable-model-invocation: true
---

# /semgrep — 意味で探す

`semgrep`（TypeSafe Jev で 1 行ずつ「この意味に合うか」の確率を出す grep）を使って、
ユーザーの言葉で示された意味に合う行を探し、結果を示す。

前提: `semgrep` は PATH にある（`npm install -g @uehaj/semgrep`）。API キーは環境変数
`TYPESAFE_API_KEY` か `./.env`、`~/.config/semgrep/.env` から読まれる。キー未設定のエラーが出たら
`--help` 末尾の設定手順をそのまま示して止まる。

**検索した行はすべて TypeSafe の API に送られる。** 対象に秘密情報や社外秘が含まれそうなら、実行前にその旨を 1 行添える。

## 手順

1. **引数を読む。** `$ARGUMENTS` は「探したい意味」と、あれば「対象」（ファイル、glob、ディレクトリ、または `git log` のようなコマンド出力）。
   対象が無ければ会話の文脈から決め、決められなければ聞く。カレント全体（`-r .`）は行ごとに課金されるので、明示されたときだけ使う。
2. **意味を式に組む。** 意味は英語で書く（精度が最も安定する。ユーザーが日本語で言っても英訳してよい）。
   「A または B」は `-e A -e B`、「A かつ B」は `-e A -a B`、「A だが B でない」は `-e A -v B`。
   1 つの意味に複数の条件を詰め込まず、条件ごとに `-e/-a/-v` に分ける。
3. **実行する。** 常に `-n` を付ける。複数ファイルやディレクトリなら `-r`。前後が要る依頼なら `-C 2`。
   例:

   ```sh
   semgrep -n -e "customer is asking for a refund" -v "the refund was already issued" tickets/*.txt
   git log --oneline -200 | semgrep -n -e "the author admits the fix is untested"
   ```

4. **結果を判定する。** 出力の各行を読み、意味に合っていない行が混ざっていれば `-p` を付けて確率を確かめ、
   `--level strict` で再実行する。何も出なければ `--level loose` で再実行し、それでも無ければ「該当なし」と伝える。
   終了コード 2 はエラーなので stderr をそのまま示す。
5. **報告する。** `file:line:` 付きの該当行をそのまま示し、件数と、絞り込みに使った式を 1 行添える。
   ユーザーが次に打てるコマンドを 1 つ提案する（`-C` で文脈、`-l` でファイル名だけ、`-c` で件数、など）。

完了条件: 該当行が `file:line` 付きで示されているか、「該当なし」と根拠（式と閾値）が示されている。

## オプション早見

`semgrep --help` が正。ここは式の組み方に関わるものだけ。

| 目的 | オプション |
|---|---|
| OR / AND / AND NOT | `-e A -e B` / `-e A -a B` / `-e A -v B`。`'!B'` は個別否定 |
| 取りこぼしを減らす / 確実な行だけ | `--level loose` / `--level strict`（`-t` `-T` で個別指定） |
| 確率を見る | `-p` |
| 文脈 / ファイル名だけ / 件数 | `-C N` / `-l` / `-c` |
| 再帰 | `-r`（.git、node_modules、.env や鍵は自動で除外） |

# 設計（ドラフト）

要件（[requirements.md](requirements.md)）と背景（[background.md](background.md)）をもとにした設計。PoC で確かめた内容を含む。PoC のコードはブランチ [claude/poc-deno-agentcore](https://github.com/tmokmss/agent-code-sandbox/tree/claude/poc-deno-agentcore/poc) に残してある（マージはしない）。Deno のバージョンは 2.9.7 で確かめた。

## exec の API 仕様（公開契約）

このライブラリの公開する契約。ここに書いたことは、変えるときに利用者への影響を考える。`exec()` を呼ぶのはエージェントを作る開発者のコードで、LLM ではない。なので、開発者が意図して選ぶ設定（広いパスの許可、ホストの環境変数をまとめて渡すなど）は許す。拒否するのは、ほかのオプションの保証を開発者が気づかないうちに壊すものだけにする。

### 関数

```ts
export function exec(options: ExecOptions): Promise<ExecResult>;
```

### ExecOptions

`code` と `entrypoint` は union にして、どちらか一方だけを型で強制する。呼び出しの形は平らなまま（`exec({ code, workDir })`）で、入れ子にしない。実行時にも同じ検査をする（JS から呼ばれる場合のため）。

名前は、ディレクトリを指すものを `workDir` と `readOnlyDirs` にそろえる。読み取り専用はディレクトリだけにする。ファイル 1 つだけを見せたいときは、それを入れたディレクトリを指定する。

```ts
type CommonOptions = {
  readOnlyDirs?: string[];
  allowedPackages?: string[];
  allowedDomains?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  memoryMb?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
};

// code と entrypoint は、どちらか一方だけを必ず指定する。
// 両方を書いたり、どちらも書かなかったりすると型エラーになる。
// workDir は、code のときは省略でき、entrypoint のときは必須。
export type ExecOptions =
  | (CommonOptions & { code: string; workDir?: string; entrypoint?: never })
  | (CommonOptions & { entrypoint: string; workDir: string; code?: never });
```

| オプション | 既定値 | 意味 |
|---|---|---|
| `code` | なし | 実行する JS / TS のコード。`entrypoint` とどちらか一方だけを指定する。ES モジュールとして実行し、トップレベルの `await` を使える。相対 import は `workDir` から解決する |
| `entrypoint` | なし | `workDir` の中のファイルのパス（`workDir` からの相対パス、または `workDir` の中を指す絶対パス）。`code` とどちらか一方だけを指定する |
| `workDir` | `entrypoint` のときは必須。`code` のときは省略できる | 作業ディレクトリ。存在している必要がある。サンドボックスのコードは読み書きでき、実行をまたいでファイルが残る。`code` で省略したときは、実行ごとに空の一時ディレクトリを作り、終わったら消す（単発の計算などで、ファイルを残す必要がないとき） |
| `readOnlyDirs` | `[]` | 読み取りだけを許可するディレクトリ。中のファイルとサブディレクトリを読める |
| `allowedPackages` | 指定なし | import してよい npm パッケージ。`"name"` か `"name@range"`（範囲は `*`、`5`、`5.7`、`5.7.0`、`^5.1.0`、`~5.1.0`）。指定しないときはどのパッケージも使える。`[]` はどれも使えない。許可したパッケージの依存は自動で許可する |
| `allowedDomains` | `[]` | 通信を許可する先。`"api.example.com"`（全ポート）、`"api.example.com:443"`、`"*.example.com"`、IP アドレス。`[]` はすべて拒否する |
| `env` | `{}` | サンドボックスのコードに見せる環境変数。ここで渡した名前だけを読める。ホストの値を渡すときは `{ KEY: process.env.KEY! }` や `{ ...process.env }` のように開発者が選んで書く |
| `timeoutMs` | 無制限 | 実行時間の上限。超えたら止めて `timedOut: true` を返す。パッケージの取得の時間は含めない |
| `memoryMb` | 無制限（V8 の既定） | JS のヒープの上限。指定したときだけ `--max-old-space-size` を付ける |
| `maxOutputBytes` | `1048576`（1 MB） | `stdout` と `stderr` のそれぞれで、ホストのメモリに溜める上限（バイト）。超えた分は先頭と末尾を半分ずつ残して真ん中を捨てる。ホストのプロセスを守るための上限で、LLM に渡す量の調整ではない（それは呼ぶ側で行う） |
| `signal` | なし | 渡した `AbortSignal` が中断されたら、実行を止める。返り値は `timedOut` と同じ形で、`stderr` に中断したことを書く |

### ExecResult

```ts
export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
};
```

| フィールド | 意味 |
|---|---|
| `stdout` | 標準出力 |
| `stderr` | 標準エラー。LLM が直せるように書き換えたもの（[3. エラー時の情報](#3-エラー時にllm-が直せるだけの情報を出す)） |
| `exitCode` | 終了コード。実行前に拒否したときは `1`。止めたとき（時間切れ、中断）は `null` |
| `timedOut` | 時間切れか中断で止めたとき `true` |
| `truncated` | `stdout` か `stderr` を切り詰めたとき `true` |
| `durationMs` | `exec()` の呼び出しから返るまでの時間 |

### 返すか、例外を投げるか

LLM が直せるものは結果として返し、開発者が直すものは例外を投げる。エージェントは結果をそのまま LLM に渡せばよい。

| 起きたこと | 扱い |
|---|---|
| コードの例外、構文の誤り、権限の拒否 | 結果を返す（`exitCode` が 0 以外） |
| 実行前の拒否：許可外のパッケージやバージョン、許可したパスの外のファイルの import、`jsr:` や URL の import、存在しないパッケージ | 結果を返す（`exitCode: 1`、`stderr` に理由） |
| 時間切れ、`signal` での中断 | 結果を返す（`exitCode: null`、`timedOut: true`） |
| オプションの誤り：`code` と `entrypoint` の両方か片方もない、`entrypoint` なのに `workDir` がない（どちらも JS から呼んだとき）、`workDir` が存在しないかディレクトリでない、`readOnlyDirs` にディレクトリでないものがある、パスやホスト名にカンマや空白がある、予約された環境変数の名前、範囲の書式の誤り | `SandboxConfigError` を投げる |
| 許可したパスの中に、外を指すシンボリックリンクがある | `SandboxConfigError` を投げる（置いたのはホスト側なので） |
| 環境の問題：Deno の入手の失敗、registry に届かない | `SandboxError` を投げる |

### 予約された環境変数

`env` に次の名前があれば `SandboxConfigError` を投げる。どれも、ほかのオプションの保証を黙って壊すため。

| 名前 | 理由 |
|---|---|
| `DENO_*` | `DENO_DIR` でパッケージのビューが差し替わり、`allowedPackages` が効かなくなる。ほかも Deno の動きを変える |
| `LD_*`、`DYLD_*` | `LD_PRELOAD` などで Deno のプロセスに任意のライブラリを読み込ませ、権限の検査そのものを外せる |
| `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`（大文字と小文字） | 拡張（パス単位の制御、認証ヘッダーの注入）で、ライブラリが内蔵のプロキシを指すのに使う。開発者の値と混ざると、その制御を通らない経路ができる |

`env` は B（実行）の段階だけに渡し、A1 と A2 には渡さない。Deno には `--allow-env=<渡した名前>` と `--ignore-env` を付ける。`--ignore-env` で、渡していない名前は例外にならず `undefined` を返す（Node と同じ）。これがないと `process.env.X ?? "既定値"` や `JSON.stringify(process.env)` が権限エラーで落ちる。

### 守ること（サンドボックスのコードから見て）

- 読めるのは `workDir` と `readOnlyDirs` だけ。書けるのは `workDir` だけ。静的な import やシンボリックリンクを経由しても同じ
- 通信できるのは `allowedDomains` だけ。リダイレクト先も検査する
- 見える環境変数は `env` で渡したものだけ
- サブプロセス、FFI、システムの情報（`--allow-sys`）は使えない
- import できる npm パッケージは `allowedPackages` とその依存だけ。実行時に決まる import や、前の実行のキャッシュでも同じ。インストールスクリプトは実行しない
- 前の実行の変数などは残らない。残るのは `workDir` のファイルだけ（`workDir` を省略したときは何も残らない）

### 並行して呼ぶとき

`exec()` は並行して呼んでよい。パッケージのストアとビューは共有し、壊れないように作る。同じ `workDir` を並行した実行で使うときのファイルの競合は、呼ぶ側が避ける。

### 使い方の例

```ts
// 単発の計算。ファイルを残す必要がなければ workDir は要らない
const { stdout } = await exec({ code: "console.log(2 ** 10)" });

import { exec } from "agent-code-sandbox";

const result = await exec({
  code: llmGeneratedCode,
  workDir: `/tmp/session-${sessionId}`,
  readOnlyDirs: ["/data/uploads"],
  allowedPackages: ["papaparse@5", "date-fns"],
  allowedDomains: ["api.example.com"],
  env: { API_BASE_URL: "https://api.example.com" },
  timeoutMs: 30_000,
});
// LLM へは、stdout と stderr をそのまま渡せばよい
return [result.stdout, result.stderr].filter(Boolean).join("\n");
```

### ライブラリの設定（環境変数）

Deno の入手先やキャッシュの場所は、`exec()` のオプションではなく環境変数で変える。

| 名前 | 意味 |
|---|---|
| `AGENT_CODE_SANDBOX_DENO_PATH` | 使う Deno のパス |
| `AGENT_CODE_SANDBOX_DENO_BASE_URL` | Deno のダウンロード元（GitHub の releases のミラー）。SHA-256 の照合はそのまま行う |
| `AGENT_CODE_SANDBOX_CACHE_DIR` | Deno と npm パッケージのキャッシュの場所。既定は `~/.cache/agent-code-sandbox`。書き込めなければ一時ディレクトリを使う（AgentCore Runtime のコードの直接デプロイでは、ホームに書けないことがあるため） |

### 未決のもの

- `allowedDomains` の拡張（パスやメソッド単位の制御、認証ヘッダーの注入）を足すときの形

## 全体の流れ

`exec()` は 1 回の実行で Deno を 2〜3 回起動する。

| 段階 | Deno のコマンド | 通信 | ユーザーのコードを実行するか | やること |
|---|---|---|---|---|
| A1. 検査 | `deno info --json --no-npm --no-remote` | なし | しない | 静的な import をすべて列挙し、ファイルの場所と npm パッケージを検査する |
| A2. 取得 | `deno cache --lock=<実行ごとのロック>` | registry だけ | しない | npm パッケージを共有のストアに取得し、解決したバージョンをロックファイルに固定する。import に npm がないときは飛ばす |
| B. 実行 | `deno run --frozen --cached-only ...` | 許可したホストだけ | する | 権限を絞って実行する |

A1 と A2 ではユーザーのコードを実行しない。B では registry に通信できない。これで「取得の段階と実行の段階を分ける」を満たす。

## Node と Deno の受け渡し

### 起動

- `child_process.spawn` で Deno を起動する。シェルは通さない
- 環境変数はホストから引き継がず、次だけを渡す：`DENO_DIR`、`NO_COLOR=1`、`DENO_NO_UPDATE_CHECK=1`、`DENO_NO_PACKAGE_JSON=1`、`HOME`、`PATH`
  - Deno は `--allow-env` がなければ環境変数を読ませないが、子プロセスに秘密を渡さないこと自体を基本にする
  - B では、これに `env` オプションの値を足し、`--allow-env=<その名前>` を付ける
  - A2 だけは registry に届くように、ホストのプロキシ設定（`HTTPS_PROXY` など）と `DENO_CERT` を渡す
- `--no-config` と `DENO_NO_PACKAGE_JSON=1` で、作業ディレクトリに置かれた `deno.json` や `package.json` を無視する。`package.json` は `--no-config` だけでは読まれてしまうことを確かめた
- 作業ディレクトリをカレントディレクトリにする

### コードの渡し方

- `code` は作業ディレクトリに隠しファイル（`.sandbox-<乱数>.ts`）として書き、終わったら消す
  - 相対 import を作業ディレクトリから解決できる
  - A1 と B で同じファイルを見るので、検査したグラフと実行するグラフが一致する
  - 標準入力（`deno run -`）で渡す案は、`deno info` に渡せないので採らない
- `entrypoint` はそのまま渡す。作業ディレクトリの外を指したら A1 で拒否する
- 拡張子は `.ts` にする。JS はそのまま TS として読める。型検査はしない（`deno run` の既定）。型の誤りで止めるより、動かして結果を見せたほうが LLM が直しやすい

### 結果の受け取り

- 標準出力と標準エラーをパイプで受け取る。上限を超えた分は先頭と末尾を残して真ん中を捨てる（後述）
- 終了コードを返す。タイムアウトで止めたときは `exitCode: null`、`timedOut: true`
- 結果の型は [ExecResult](#execresult) のとおり

### 資源の制限

- 実行時間：上限を超えたら `SIGKILL`。Deno は子プロセスを作れない（`--allow-run` を与えない）ので、1 つのプロセスを止めれば済む
- メモリ：`--v8-flags=--max-old-space-size=<MB>` で JS のヒープを制限する。`ArrayBuffer` などヒープの外のメモリは制限されないので、次の段階で Node 側から RSS を監視して止める（Linux は `/proc/<pid>/status`）
- 出力：Node 側で受け取りながら切り詰めるので、出力が多くてもホストのメモリは増えない

### Deno に渡すフラグ（B. 実行）

```
deno run
  --no-config --no-remote --cached-only
  --lock=<実行ごとのロック> --frozen
  --no-prompt
  --allow-read=<作業ディレクトリ>,<読み取り専用ディレクトリ...>
  --allow-write=<作業ディレクトリ>
  --allow-net=<許可したホスト...>        # 指定がなければ付けない（全拒否）
  --allow-env=<env で渡した名前...>       # 指定がなければ付けない
  --ignore-env                           # 渡していない名前は undefined を返す
  --v8-flags=--max-old-space-size=<MB>   # memoryMb を指定したときだけ
  <entry>
```

`--allow-run`、`--allow-ffi`、`--allow-sys`、`--allow-all`、`--allow-scripts`、名前を絞らない `--allow-env` は付けない。

`--allow-read` と `--allow-write` には、実体のパスと開発者が書いたパスの両方を渡す。Deno はコードが使ったパスをシンボリックリンクを解決せずに検査するので、macOS の `/var`（実体は `/private/var`）のように、書いたパスで読めなくなるのを防ぐ。

Deno は権限のリストをカンマで区切るので、パスやホスト名にカンマや空白があれば実行前に拒否する（`/tmp/a,/etc` が `/etc` の許可になるのを防ぐ）。

### Deno の入手

- `PATH` に `deno` があればそれを使う。なければ初回の実行時に、固定したバージョンの Deno をダウンロードし、SHA-256（ライブラリに埋め込んだ値）を照合してキャッシュに置く
- 対応する環境：Linux（x86_64 / arm64）と macOS（x86_64 / arm64）。ダウンロードは Node の標準の機能だけで行う（zip の展開も自前で行い、外部コマンドに頼らない）
- AgentCore Runtime はコンテナのほかに、Node.js 22 のコードを zip で直接デプロイする形（`NODE_22`）も扱える。この形ではイメージに Deno を入れられないので、初回のダウンロードが必要になる
- ダウンロードは Node の `https` で行い、`HTTPS_PROXY` と `NO_PROXY` を見る（Node の `fetch` は `NODE_USE_ENV_PROXY` がないとプロキシを使わないため）
- 実装ではダウンロードを採った。別案は npm の `deno` パッケージ（OS ごとのバイナリを optionalDependencies で配る）に依存すること。インストール時に入るので初回の待ちはないが、依存が増え、パッケージの入れ方（`--omit=optional` など）で入らないことがある

## パッケージの許可リストの検査

### 調べて分かったこと

PoC の前に、Deno の権限がどこまで効くかを試した。許可リストを素直に作ると回避できる経路が 3 つあった。

| # | 分かったこと | 影響 |
|---|---|---|
| 1 | 静的な import（文字列リテラルの `import` と `import()`）は、ローカルのファイルでも `--allow-read` の検査を受けない。`import s from "/etc/passwd" with { type: "text" }` で読めた | 許可していないファイルを読める |
| 2 | `DENO_DIR` の npm キャッシュの中は、`--allow-read` がなくても読み込める。`import("file://<キャッシュ>/lodash/...")`、`import("npm:papaparse@5/../../lodash/...")`、`createRequire(...)("<キャッシュのパス>")` で、許可していない（前の実行でキャッシュされた）パッケージを読み込めた | キャッシュ経由で許可リストを回避できる |
| 3 | `--frozen` のロックファイルを渡すと、`import("npm:" + 変数)` でロックにないパッケージを足そうとした時点でエラーになる | 実行時に決まる import は、ロックで止められる |

そのほか：

- `Deno.symlink` は、パスを絞った `--allow-read` / `--allow-write` では使えない。サンドボックスのコードはシンボリックリンクを作れない
- ただし、ホスト（やエージェントのほかのツール）が作業ディレクトリに置いたシンボリックリンクは、たどって外のファイルを読める
- 権限の検査は、ホスト名とポートで行われる。リダイレクト先も検査される。`node:net`、`node:http`、`WebSocket` も同じ検査を通る

### 方式：3 段で止める

**A1. 静的なグラフの検査（ダウンロードの前）**

`deno info --json --no-npm --no-remote` で、通信せずに静的な import をすべて列挙する。次のどれかに当てはまらなければ、実行前にエラーにする。

- `file:`：実体（`realpath`）が作業ディレクトリか読み取り専用ディレクトリの中にある（分かったこと 1 への対策）
- `npm:`：許可リストにあるパッケージ名（許可リストを指定しないときはすべて可）
- `node:`（組み込みモジュール）、`data:`（インラインのモジュール。その中の import もグラフに含まれて検査される）

`jsr:` や `https:` は拒否する。あわせて、許可したパスの中を走査し、外を指すシンボリックリンクがあれば拒否する。

**A2. 取得とバージョンの検査**

`deno cache --lock=<実行ごとのロック>` で、共有のストア（A 段階専用の `DENO_DIR`）にパッケージを取得する。インストールスクリプトは `--allow-scripts` を付けないので実行されない。ロックファイルの `specifiers`（コードに書かれた指定子と、解決したバージョン）を許可リストのバージョン範囲と照合する。依存パッケージは許可したパッケージから引かれたものなので、自動で許可する。

**B. ビューで実行する**

ロックファイルにあるパッケージだけをストアからハードリンクした `DENO_DIR`（ビュー）を作り、B はこれを `DENO_DIR` にして実行する。ストアにほかのパッケージがあっても、ビューの中にはないので読み込めない（分かったこと 2 への対策）。あわせて `--frozen --cached-only --no-remote` を付けるので、実行時に決まる import で新しいパッケージを足すこともできない（分かったこと 3）。

ビューはパッケージの組み合わせ（ロックの内容のハッシュ）ごとに作って使い回す。ハードリンクなので容量はほとんど増えない。

### この方式で許すもの

- 実行時に決まる import でも、ロックにある（つまり許可した）パッケージは使える。許可リストの意図どおり
- 作業ディレクトリに書いた自分のコードは import できる。LLM が npm パッケージの中身を手で書き写すことは止めないが、それは自分のコードを書くのと同じで、許可リストが守りたいもの（registry から任意のパッケージを取ってくること）とは関係ない

### 残る課題

- ストアとビューの掃除（古いものを消す）
- 並行して実行したときのビューの作成（PoC は一時ディレクトリに作ってから rename する）
- 許可したパスが大きいとき、シンボリックリンクの走査が重くなる。要件で「ホストは許可外を指すリンクを置かない」と決めて走査をやめる案もある
- npm 以外の registry（社内の registry）への対応

## 通信の制御

**推奨：初版は Deno の `--allow-net` で制御する。** egress プロキシは拡張（パス・メソッド単位の制御、通信ログ、認証ヘッダーの注入）を作るときに足す。

`--allow-net` を選ぶ理由：

- 追加の部品が要らない。VM の中でもそのまま動く
- fetch、`node:http`、`node:net`、`WebSocket`、リダイレクト先まで、同じ検査を通る（PoC で確認）
- 既定は全拒否なので、メタデータのエンドポイント（`169.254.169.254`、`169.254.170.2`）や registry にも届かない
- `*.example.com` の形でサブドメインをまとめて許可できる

弱点：

- 判定はホスト名とポートで行い、名前解決したあとの IP は見ない。許可したホストが内部の IP を指していれば届く。許可したのは開発者なので、初版では許容する
- 通信の中身（パスやメソッド）は見られない

拡張するときの形：

- Node 側にプロキシを内蔵し、Deno には `HTTPS_PROXY=http://127.0.0.1:<port>` を渡す
- Deno はプロキシを使うときも、権限は接続先のホストで検査する（PoC の調査で、`--allow-net=<接続先>` だけでプロキシ経由の通信が試みられることを確認した）。なので `--allow-net` は残し、プロキシを迂回する直接の通信を塞ぐ二重の構えにする
- 認証ヘッダーの注入には TLS の終端が要る。プロキシ用の CA を作り、`DENO_CERT` で Deno に渡す

## 未確定の 4 項目への意見

### 1. パッケージの取得と実行を別の段階に分ける

**賛成。** 加えて、分けることが許可リストの検査の前提になると分かった。取得の段階でロックファイルを作り、実行の段階でそれを `--frozen` で固定し、ビューを作るからである。キャッシュが効いていれば、A 段階の追加の時間は 20 ms 前後（後述）。

### 2. 戻り値は返さず、標準出力だけを返す

**賛成。** そのうえで、結果には `timedOut`、`truncated` も返す（LLM に「止められた」「切り詰めた」を伝えるため）。`stdout` と `stderr` は分けて返し、LLM に渡すときに連結するかはエージェント側に任せる。構造化したデータを受け取りたいときは、作業ディレクトリに JSON を書いてホストが読めばよいので、戻り値の仕組みは要らない。

### 3. エラー時に、LLM が直せるだけの情報を出す

**賛成。** 具体的には次のことを行う（PoC で実装済み）。

- Deno の権限エラーにある「`--allow-net` を付けて再実行せよ」という案内は、LLM には実行できないので書き換える。何が許可されているか（許可したホストの一覧など）を示す
- `code` を書いた一時ファイルのパスを `<code>` に置き換える。行番号はそのまま残る
- Deno 内部のスタックの行（`ext:` から始まるもの）を消す
- 実行前に拒否したとき（許可外のパッケージ、外のファイルの import など）も、同じく標準エラーに理由を書き、`exitCode` を 1 にする。LLM から見て同じ形で扱える

PoC での出力の例：

```
error: Uncaught (in promise) NotCapable: Network access to "169.254.169.254:80" is not allowed in the sandbox. Allowed hosts: api.example.com
await fetch("http://169.254.169.254/latest/meta-data/")
      ^
    at new Promise (<anonymous>)
    at <code>:1:7
```

```
Package "lodash" is not allowed. Allowed packages: papaparse@5
```

### 4. 出力が上限を超えたら切り詰める

**賛成。ただし目的は、LLM のコンテキストではなく、ホストのプロセスを守ること。** 上限がないと、`while (true) console.log(...)` のようなコードの出力を、返すまでホストのメモリにすべて溜めることになり、エージェントのプロセスが落ちる（脅威モデルの「ホストの可用性」）。なので、受け取りながら切り詰める仕組みはライブラリに要る。既定値は大きめ（1 MB）にする。

LLM に渡す量をどこまで絞るかは、モデルや用途で変わるので呼ぶ側で行う。ライブラリの上限より小さく絞りたいときも、`maxOutputBytes` を小さくすれば同じ形で切り詰められる。

切り詰めるときは、先頭と末尾を半分ずつ残し、真ん中を捨てる。エラーは最後に出ることが多いので、末尾を残すのが大事。捨てたところには、捨てたバイト数と「大きな出力はファイルに書くこと」という案内を入れる。

### 文書の言語

**推奨：要件と設計が固まるまでは日本語のまま進め、最初の公開（v0.1）の前に英語に置き換える。** README と API のドキュメントは最初から英語で書く。設計の議論は母語のほうが速く、置き換えは機械翻訳と見直しで済むため。

## 要件に反映したほうがよい点

- ファイル：「静的な import を経由しても、許可していないファイルを読めない」を加える（分かったこと 1）
- ファイル：ホストが置いたシンボリックリンクの扱いを決める（走査して拒否するか、置かないことを利用者の責任にするか）
- 結果：`timedOut` と `truncated` を加える
- 環境変数：`env` オプションで、渡した名前だけを見せられるようにする（予約された名前は拒否する）
- 非機能要件：AgentCore Runtime のコードの直接デプロイ（`NODE_22`）でも動くこと

## PoC の結果

- 実装：[poc/src/exec.ts](https://github.com/tmokmss/agent-code-sandbox/blob/claude/poc-deno-agentcore/poc/src/exec.ts)。テスト：[poc/test/sandbox.test.ts](https://github.com/tmokmss/agent-code-sandbox/blob/claude/poc-deno-agentcore/poc/test/sandbox.test.ts)（25 件）
- 環境：Firecracker の microVM（Linux 6.18、x86_64）。root（uid 0）と、root でないユーザー（uid 65534）の両方で、25 件すべて通った。OS の分離機構は使っていない
- 1 回の実行にかかる時間（キャッシュが効いている状態）

| 内容 | 合計 | A1 検査 | A2 取得 | B 実行 |
|---|---|---|---|---|
| npm を使わないコード | 約 36 ms | 11 ms | なし | 24 ms |
| npm パッケージ 1 つを使うコード | 約 77 ms | 11 ms | 12 ms | 54 ms |

要件の「数百 ms 以内」を満たす。

### AgentCore Runtime 上の結果

コードの直接デプロイ（`NODE_22`、us-west-2、arm64、Linux 6.1、uid 991）で、25 件すべて通った。手順は [poc/README.md](https://github.com/tmokmss/agent-code-sandbox/blob/claude/poc-deno-agentcore/poc/README.md) にある。

- ホストのプロセスはメタデータのエンドポイント（`169.254.169.254`）に届く（IMDSv2 のトークンなしで 401 が返る）。サンドボックスのコードからは、`169.254.169.254` と `169.254.170.2` のどちらにも届かない
- サンドボックスのコードは、環境変数、`/proc/self/environ`、`/etc/passwd`、サブプロセスのどれも使えない
- 1 回の実行にかかる時間

| 内容 | 合計 | A1 検査 | A2 取得 | B 実行 |
|---|---|---|---|---|
| npm を使わないコード | 約 22 ms | 6 ms | なし | 15 ms |
| npm パッケージ 1 つ（初回、registry から取得） | 約 202 ms | 7 ms | 116 ms | 72 ms |
| npm パッケージ 1 つ（2 回目） | 約 51 ms | 6 ms | 6 ms | 38 ms |

コードの直接デプロイでは、TypeScript を `deno bundle` で JS にまとめ、arm64 の Deno のバイナリを zip に入れた。エントリーポイントの拡張子は `.js` でなければならない。

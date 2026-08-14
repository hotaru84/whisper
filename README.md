# WhisperScribe

録音した音声を完全オフラインで文字起こしする Windows デスクトップアプリ。Tauri (Rust) + React/TypeScript + [`whisper-rs`](https://github.com/tazz4843/whisper-rs)（[whisper.cpp](https://github.com/ggml-org/whisper.cpp) の Rust バインディング、`large-v3-turbo` モデル）で構成。文字起こし推論は Rust バックエンドで実行し、Vulkan 経由で GPU アクセラレーションする。

## 前提環境

- [Node.js](https://nodejs.org/)（v22 系で動作確認）
- [Rust](https://www.rust-lang.org/tools/install) と Cargo
- [CMake](https://cmake.org/download/)（`whisper-rs` が内部で whisper.cpp を CMake ビルドする）
- **LLVM** — `winget install LLVM.LLVM`。`whisper-rs-sys` の bindgen が `libclang` を必要とする。
  既定の `C:\Program Files\LLVM\bin` にあればビルドスクリプトが自動検出するので、環境変数の設定は不要。
- **Vulkan SDK** — `winget install KhronosGroup.VulkanSDK`。GPU 推論のビルドに必要。
  既定の `C:\VulkanSDK\<version>` にあればビルドスクリプトが自動検出するので、環境変数の設定は不要
  （別の場所に入れた場合のみ `VULKAN_SDK` を自分で設定する）。実行時に必要なのは GPU ドライバ同梱の
  `vulkan-1.dll` だけで、配布先に SDK は不要。
- Windows: WebView2 ランタイム（通常は Windows に同梱済み）
- Windows: Visual Studio Build Tools（「C++ によるデスクトップ開発」ワークロード）
  - リソースコンパイラ `rc.exe` が `PATH` に含まれていない環境がある。含まれていない場合、`tauri build`/`tauri dev` が
    `RC.EXE failed to compile specified resource file` で失敗する。その場合は Windows SDK の `bin\<version>\x64` ディレクトリ
    （例: `C:\Program Files (x86)\Windows Kits\10\bin\10.0.19041.0\x64`）をユーザー環境変数 `PATH` に追加する。

GPU が Vulkan に対応しているかは `vulkaninfo --summary` で確認できる（`Devices:` に GPU が出れば可）。

### ビルドは必ず npm スクリプト経由で

`npm run tauri ...` は [`scripts/win-build-env.bat`](scripts/win-build-env.bat) を経由してビルド環境を整えてから
Tauri CLI を呼ぶ。**`cargo build` を直接叩くと CMake の段階で失敗する。** ラッパーがやっているのは以下:

- `vswhere` で Visual Studio を検出し `vcvars64` を実行して `cl.exe` を `PATH` に載せる
- VS 同梱の **Ninja** を `PATH` に追加する（追加インストール不要）
- `LIBCLANG_PATH` の自動検出と、`VULKAN_SDK` の存在チェック

なぜこれが要るかというと、ggml は Vulkan シェーダーを生成する `vulkan-shaders-gen` を**入れ子の CMake
ExternalProject** としてビルドするが、非クロスコンパイル時はそこにコンパイラ設定を一切渡さない実装になっている
（`ggml/src/ggml-vulkan/CMakeLists.txt`）。そのため `cl.exe` が環境から見つかる必要があり、かつ Visual Studio
ジェネレータでは入れ子の configure が `No CMAKE_C_COMPILER could be found` で失敗するため Ninja が必須になる。

ビルド設定のうち宣言的に書けるもの（Ninja ジェネレータの指定、`MAX_PATH` 回避のための短いターゲット
ディレクトリ `C:/wsbuild`）は [`.cargo/config.toml`](.cargo/config.toml) にある。**リポジトリ直下に置くこと。**
Cargo は設定をマニフェストではなく*カレントディレクトリ*から上位に向かって探すため、`src-tauri/` 配下に置くと
リポジトリルートから実行したコマンドが黙って設定を読み飛ばす。

**特に `CMAKE_GENERATOR` の指定を外してはいけない。** 指定が無いと `cmake` クレートが whisper.cpp の
最適化フラグ（`/O2`）を消してしまい、推論が約8倍遅くなる（実測: エンコーダ 27秒 → 223秒）。詳細は当該ファイルのコメント参照。

## セットアップ

```powershell
npm install
```

### Whisper モデルファイルの配置（初回のみ）

モデルの GGUF ファイルはサイズが大きい（約 574MB）ためリポジトリには含めていない。初回ビルド前に
`src-tauri/resources/models/whisper-large-v3-turbo/model.gguf` として以下を配置する。

```powershell
$dest = "src-tauri/resources/models/whisper-large-v3-turbo"
New-Item -ItemType Directory -Force $dest | Out-Null
Invoke-WebRequest -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin" -OutFile "$dest/model.gguf"
```

- `q5_0` 量子化版（約574MB）を既定として使用する。fp16 に近い精度を保ちつつ CPU 推論速度とサイズのバランスが良い。
  より高精度な `q8_0`（約874MB）や無量子化の `f16`（約1.62GB）を試したい場合は、同じ Hugging Face リポジトリから
  該当ファイルをダウンロドし、同じパス（`model.gguf`）に配置し直せばよい（ランタイムでの切替はサポートしていない）。
- whisper.cpp は語彙・トークナイザーを GGUF ファイル自体に内包しているため、旧構成のような複数ファイル
  （tokenizer/config JSON、`onnx/` サブフォルダ）は不要。

**`src-tauri/resources/models/` 配下には旧 Transformers.js 実装の名残（`kotoba-whisper-v2.2`、`whisper-base`、
計約2.6GB）が残っていることがある。** これは現在のバックエンドからは一切参照されない死んだファイルなので、
削除してよい（`whisper-large-v3-turbo/` だけ残す）。`tauri.conf.json` の `bundle.resources` は
`resources/models/whisper-large-v3-turbo/**/*` だけを明示的に指定しており、この配下に無いものはどのみち
インストーラには入らない。**新しいモデル（VAD、話者分離、音響イベント検出など）を追加するときは、この
`bundle.resources` の配列にそのモデルのディレクトリを明示的に追記すること。** `resources/models/**/*` の
ような広い glob に戻すと、リポジトリの手元に置いた不要なモデルまで気づかず同梱してしまう
（実際に旧実装のモデルで3.2GBまで膨らんでいた）。

### 話者分離モデルの配置（任意機能）

話者分離を使う場合のみ必要。無くてもアプリ本体・文字起こしは動く（設定で話者分離を有効にしない限り
これらのモデルには触れない）。`src-tauri/src/diarize.rs` が読むパスに合わせて配置する。

```powershell
$dest = "src-tauri/resources/models/diarization"
New-Item -ItemType Directory -Force $dest | Out-Null
Invoke-WebRequest -Uri "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2" -OutFile "$dest/segmentation.tar.bz2"
tar -xjf "$dest/segmentation.tar.bz2" -C $dest
Move-Item "$dest/sherpa-onnx-pyannote-segmentation-3-0/model.onnx" "$dest/segmentation.onnx"
Remove-Item -Recurse -Force "$dest/sherpa-onnx-pyannote-segmentation-3-0", "$dest/segmentation.tar.bz2"
Invoke-WebRequest -Uri "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx" -OutFile "$dest/embedding.onnx"
```

- **セグメンテーションモデル**（pyannote 由来、約6.6MB）: 元の `pyannote/segmentation-3.0` は Hugging Face 上で
  ゲート付き配布だが、**ライセンス自体は MIT** で常にオープンソースであることが明記されている
  （[ライセンス表記](https://huggingface.co/pyannote/segmentation-3.0)）。ここで使う sherpa-onnx 版はその
  MIT ライセンスの重みから抽出された ONNX ミラーを k2-fsa が自前で再配布したものなので、ゲート越え・
  HuggingFace トークンの取得は不要。
- **埋め込みモデル**（約27MB）: 3D-Speaker の CAM++（中国語・英語共通学習）を使う。日本語には未対応の名称に
  見えるが、話者埋め込みは声質を捉えるものでテキスト言語に依存しないため、日本語の会議でも問題なく機能する
  （話者分離の分野で一般的な前提）。
- 話者数は指定せず、クラスタリングの閾値（既定 0.5）から自動推定する。人数が既知の場合のみ設定で固定できる。

**話者分離は `sherpa-onnx` を `shared`（DLL）リンクで使っている**（既定の `static` はこのマシンのリンカでは
41件のシンボル未解決になる。詳細は `Cargo.toml` の該当箇所のコメントを参照）。そのため `sherpa-onnx-c-api.dll` /
`onnxruntime.dll` など計4つの DLL が実行時に必要になる。これらは `cargo build` 時に Cargo のターゲット
ディレクトリ（`.cargo/config.toml` で `C:/wsbuild`）へ自動生成されるが、`src-tauri/resources/` 配下ではないため
そのままでは NSIS インストーラに含まれない。`tauri.conf.json` の `build.beforeBundleCommand` が
[`scripts/copy-sherpa-dlls.ps1`](scripts/copy-sherpa-dlls.ps1) を実行し、ビルド直後にそのターゲットディレクトリ
から `src-tauri/resources/bin/` へコピーしてから `bundle.resources` の対象に含めている。この一連の流れは
`npm run tauri build` の中で自動的に走るため、手動での追加操作は不要。

### VAD モデルの配置（任意機能・既定で有効）

停止後の精度向上パスで無音区間を除く音声区間検出（VAD）に使う。**設定パネルでは既定オン**だが、モデルファイル
が無くても文字起こし自体は失敗しない — 見つからない場合は VAD 無しで続行し、その旨を画面に表示する
（`asr::transcribe_recording` の `vad_unavailable`）。

```powershell
$dest = "src-tauri/resources/models/vad"
New-Item -ItemType Directory -Force $dest | Out-Null
Invoke-WebRequest -Uri "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin" -OutFile "$dest/ggml-silero-v5.1.2.bin"
```

- Silero VAD の ggml 移植版（約864KB）。whisper.cpp の `full()` 呼び出しに内蔵の VAD として統合されており、
  非音声区間を除いた上でタイムスタンプの再マッピングまで面倒を見てくれる。自前で区間を切り出して繋ぎ直す
  実装は不要。
- **効果は実測で限定的だった。** 15秒の完全な無音に対しては、VAD の有無に関わらず `drop_silent_segments`
  （音声のRMSで無音セグメントを弾く既存の仕組み）が同じ結果（0セグメント）を返す。一方、無音区間に
  合成的な広帯域ノイズ（音声ではないが完全な無音でもない）を混ぜたケースでは、VAD を有効にしても
  「ご視聴ありがとうございました」という定番の幻覚が抑えられなかった（`drop_silent_segments` も同様。
  RMS がしきい値を超えるため無音とは判定されない）。**確認できた効果は速度面**: 15秒の無音入力で
  VAD無し 約11秒 → VAD有り 約1.8秒（デコード対象が大幅に短縮されるため）。実音声での精度への影響は
  フィクスチャが無いため未測定。
- **これは「音楽やノイズを除く」機能ではない。** VAD が対象にするのは「音声か非音声か」の判定であり、
  雑音か音楽かといった種別の判定はしない（そちらは次の音響イベント検出の役割）。

### 音響イベント検出モデルの配置（任意機能）

停止後の精度向上パスで、録音全体を音楽・拍手・ノイズなどのタグ付け（audio tagging）にかける。**設定パネルでは
既定オフ**。無くても文字起こし自体は失敗せず、有効にしない限りこれらのモデルには触れない。

```powershell
$dest = "src-tauri/resources/models/audio-tagging"
New-Item -ItemType Directory -Force $dest | Out-Null
Invoke-WebRequest -Uri "https://github.com/k2-fsa/sherpa-onnx/releases/download/audio-tagging-models/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15.tar.bz2" -OutFile "$dest/model.tar.bz2"
tar -xjf "$dest/model.tar.bz2" -C $dest --wildcards "*/model.int8.onnx" "*/class_labels_indices.csv"
Move-Item "$dest/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15/model.int8.onnx" "$dest/model.int8.onnx"
Move-Item "$dest/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15/class_labels_indices.csv" "$dest/class_labels_indices.csv"
Remove-Item -Recurse -Force "$dest/sherpa-onnx-zipformer-small-audio-tagging-2024-04-15", "$dest/model.tar.bz2"
```

- **zipformer 版（int8、約26MB）を使い、sherpa-onnx が同じページで配布している CED 版は使っていない。**
  どちらも AudioSet 527クラスのタグ付けモデルだが、ライセンスが違う。zipformer 版はアーカイブ同梱の
  `README.md`（`license: apache-2.0` の frontmatter）の通り k2-fsa 自身が icefall で学習したもので
  **Apache-2.0**。CED 版は変換元 [`RicherMans/CED`](https://github.com/RicherMans/CED) が **GPL-3.0** で、
  話者分離のときと同様にここでもライセンスを実装前に直接確認し、コピーレフトの CED を避けた。
- 10秒ごとの窓に区切って推論する（最後の窓だけ短く切る、パディングはしない）。AudioSet の学習クリップ自体が
  10秒単位のため、このモデルが実際に見て学習した長さに合わせている。
- 検出結果は**文字起こし本文には一切挿入しない**。設定パネル下の「音響イベント」欄に時刻・ラベル・確信度を
  一覧表示するだけ（`src/components/AudioEventPanel.tsx`）。ラベルは AudioSet の英語名のうち会議で意味のある
  一部だけ日本語に対応させ、対応の無いものは英語のまま出す（`src/lib/audioEvents.ts`）。
- 用途はもう一つある: 検出した窓に「発話」系のタグが一切無く「音楽」または「ノイズ」系のタグがある場合、
  その区間と重なる文字起こしチャンクを**文字起こし対象から除外する**（`events::classify_chunks`）。逆に
  発話タグが一つでもあれば、音楽やノイズが同時に検出されていても除外しない（BGM 下での発言を消さないため）。
  重なるイベントが一つも無いチャンク（検出が無効、または窓の隙間）は除外しない — 根拠が無い状態で
  文字起こしを消すのは、話者分離で根拠なく話者を割り当てないのと同じ理由で避けている。
- 音楽・ノイズ系タグの判定はラベル名に `music`/`noise` を含むかという素朴な文字列一致で、AudioSet の
  楽器サブクラス（`Guitar` 等）までは拾わない。誤った除外を避けるため、広く拾うより狭く外すことを優先した
  意図的な制約（`events.rs` のコメント参照）。
- 実機検証は k2-fsa がモデルに同梱している `test_wavs/` の3ファイルを、実際の `events::detect_events` から
  直接叩いて行った（猫の鳴き声・ピアノ曲・サイレンの録音で、それぞれ `Cat`/`Meow`、`Music`/`Piano`、
  `Siren` が確信度 0.1〜0.98 で正しく検出された）。検証用の `examples/_probe_events.rs` は確認後に削除済み。

## 開発

```powershell
npm run tauri dev
```

Vite の dev サーバー（`http://localhost:1420`）と Tauri ネイティブウィンドウが同時に起動する。文字起こし推論は
Rust バックエンド（Tauri コマンド）経由で行われるため、ブラウザで `http://localhost:1420` を直接開いた場合は
UI の確認はできるが文字起こし機能は動作しない（`invoke()`/`listen()` は Tauri ランタイム内でのみ有効）。

## ビルド

### ポータブル exe のみ（インストーラなし、動作確認に最適）

```powershell
npm run tauri build -- --no-bundle
```

`C:\wsbuild\release\whisper-scribe.exe` が生成される。`resources/` フォルダが同じ階層に必要なので、
配布する場合は exe と `resources/` フォルダをまとめてコピーする。

### インストーラ（NSIS）付きフルビルド

```powershell
npm run tauri build
```

`C:\wsbuild\release\bundle\nsis\` に生成される。モデル（q5_0、約574MB）を同梱するためインストーラサイズは
600〜650MB 程度になる。

`tauri.conf.json` の `bundle.targets` は `["nsis"]` に絞ってある。既定の `"all"` は MSI も作るため WiX
ツールセットのダウンロードが走るが、ここでは NSIS で用が足りる。日常的な動作確認には上の `--no-bundle` を使う。

## 用語集（固有名詞・専門用語のプリセット）

設定パネルの「用語集」に、聞き間違えられやすい語を「、」区切りで並べておくと、認識がその語に寄る。
whisper の `initial_prompt` として毎ウィンドウ渡している。設定は localStorage に保存され、再起動しても残る。

```
議事録、稟議書、与信管理、東京海上日動、リクルートホールディングス
```

制約を理解した上で使うこと。

- **約200文字まで。** `initial_prompt` の上限は `min(n_max_text_ctx, n_text_ctx / 2)` = このモデルでは **224トークン**。
  日本語は実測でほぼ1文字=1トークン（「議事録」3字=3トークン、「与信管理」4字=5トークン）。超えた分は**先頭から黙って捨てられる**
  ので、重要な語ほど後ろに置く。トークン数は `cargo run --release --example tokens -- "<文字列>"` で実測できる。
- **強制ではなく誘導。** 用語集に入れても必ず正しく認識されるわけではない。
- **まれに用語集の文字列がそのまま出力に混ざる**ことがある（プロンプトのエコー）。
- **温度フォールバックが 0.5 を超えると無視される**（`WHISPER_HISTORY_CONDITIONING_TEMP_CUTOFF`）。
  つまり認識が既に苦しい場面では効かなくなる。
- **ここに渡してよいのはユーザーが書いた固定テキストだけ。** モデルの出力を次のウィンドウへ戻す実装は一度試して撤回した
  （下記「やってはいけないこと」参照）。静的なテキストは自己増幅しないので安全だが、生成結果の差し戻しは別物。

効果の測定は CER ハーネスの `--prompt` / `--prompt-file` で A/B できる。

## 精度の測定

デコード設定やモデルを変えたときに、それが改善なのか改悪なのかを数値で判定するためのハーネスがある。

```powershell
scripts\win-build-env.bat cargo run --release --example cer
```

`src-tauri/fixtures/` に置いた `<name>.wav`（16kHz mono）と `<name>.txt`（正解の書き起こし）のペアを順に文字起こしし、
**CER（文字誤り率）** を表示する。日本語は単語境界が無く WER が意味を成さないため、文字単位の編集距離で測る。
フィクスチャの作り方は [`src-tauri/fixtures/README.md`](src-tauri/fixtures/README.md) を参照。

- **アプリと同じ設定で測る。** デコード設定は `asr::DecodeSettings` / `asr::build_full_params` に集約してあり、
  Tauri コマンドとハーネスが同じ関数を呼ぶ。ここが分岐すると測定値がアプリの実態を表さなくなる。
- **再ビルドせずに A/B できる。** `--beam` `--entropy-thold` `--suppress-nst` `--language` `--model` でその実行だけ
  設定を上書きできる。変更前後で実行して CER を比較する。
- **比較は一度に一項目だけ。** まとめて変えると寄与が分離できない。
- 既定では比較前に約物（、。「」等）を除去する。whisper の句読点は文体的なブレが大きく、そのままでは本体の
  誤りが埋もれるため。`--keep-punct` で残せる。`ー` や `々` は語の一部なので除去対象に含めていない。
- `--json <path>` で結果を保存でき、実行間の diff が取れる。
- CER は 100% で頭打ちにならない。幻覚で長い文が挿入されると、参照より誤りが多くなる。

CER の計算そのもの（正規化と編集距離）は `src-tauri/src/cer.rs` にありユニットテスト済み。`cargo test --lib` で走る。

**フィクスチャは自分で録音したものをそのまま使える。** アプリは録音中の音声をキャッシュディレクトリ配下の
`recordings/rec-YYYYMMDD-HHMMSS.wav` に 16kHz mono で保存している（上記「録音中の音声は WAV として…」参照）。
これを `src-tauri/fixtures/` にコピーし、同名の `.txt` に正解の書き起こしを書けばフィクスチャになる。WAV の
読み込みは本体・第2パス・ハーネスすべてが `src-tauri/src/wav.rs` を共有するので、測った値と本番の挙動が食い違わない。

## アーキテクチャ上の注意点

- **モデルは Rust バックエンドが直接ロードする。** `src-tauri/src/asr.rs` の `init_model` コマンドが
  Tauri の `resource_dir()` から GGUF ファイルパスを解決し、`whisper-rs`（`WhisperContext::new_with_params`）で
  ロードする。ロード完了/失敗は `asr:model-ready`/`asr:model-error` イベントとしてフロントエンドへ通知される
  （`src/lib/asr/client.ts` が `listen()` で受け取る）。フロントエンド側でモデルファイルのバイト列を扱う処理は
  不要になった。
- **録音は生PCMをストリーミングし、逐次文字起こしする。** マイク入力は `MediaRecorder`（WebM/Opus）ではなく
  `AudioContext({ sampleRate: 16000 })` + AudioWorklet（`public/pcm-capture-worklet.js`、`src/lib/audio/pcmRecorder.ts`）で
  16kHz mono の生 PCM として取り込む。録音全体をメモリに保持せず、フレームは `StreamingTranscriber`
  (`src/lib/asr/streaming.ts`) に流し込み、15秒たまるごとにウィンドウを文字起こしして「確定した部分だけコミット・
  末尾は次ウィンドウへ持ち越し（chunk-and-commit）」する。**ウィンドウ長はそのまま「最初の文字が出るまでの
  待ち時間」になる**（それ未満の録音は停止時にまとめて処理される）。Whisper は常に30秒分をエンコードし短い音声は
  無音でパディングするので、15秒でも30秒でも GPU コストは同じ約2秒。スループットだけなら30秒が効率的だが、
  録音開始から半分近く何も表示されないため15秒にしている。これにより長時間録音でもメモリはほぼ一定で、録音中に
  結果が逐次表示される。各ウィンドウの音声は JSON ではなく Tauri の生バイナリ IPC（`tauri::ipc::Request`）で
  Rust 側へ転送し、言語/タスク設定は HTTP ヘッダーで渡す（`transcribe_window` コマンド）。worklet は
  CSP `script-src 'self'` を満たすため `public/` から同一オリジンで配信する（`data:` へインライン化されると
  CSP に弾かれる）。
- **文字起こしはセグメントの配列で、録音のたびに追記される。** `appStore` の `segments` (`src/lib/transcript.ts` の
  `TranscriptSegment[]`) は開始→停止→開始で累積し、各セグメントは通しタイムライン上の `startOffsetSec` を持つ。
  履歴からエントリを開く（`loadHistoryEntry`）と、その内容で置き換わる。
- **録音は2パスで文字起こしする。逐次パスは「待たせないため」、停止後の第2パスは「精度のため」。**
  逐次パスの15秒ウィンドウは互いに独立してデコードされるため、ウィンドウ境界をまたぐ文はどちらの側でも
  文脈を欠いたまま推測される。録音が終われば急ぐ理由が無くなるので、**録音全体を1回の `full()` に渡す**
  （`asr::transcribe_recording`）。whisper.cpp が内部で30秒チャンクに割り、直前のチャンクのトークン列を次へ
  引き継ぐ（context conditioning）ため、逐次パスには原理的に持てない文脈が効く。結果は逐次パスのセグメントを
  差し替える形で反映され、進捗は `asr:refine-progress` イベントで届く。GPU で概ね30秒あたり2秒なので、
  1時間の会議で約4分。
  - **第2パスの間もユーザーは逐次パスの結果を読める。** 第2パスが失敗しても逐次パスの結果は保持し、
    `refineNotice` として理由だけを添える（`src/store/appStore.ts`）。既に手元にある文字起こしを、
    改善のために失うことがあってはならない。
- **録音中の音声は WAV としてディスクに追記する。** 16kHz f32 は1時間で約230MB あり、全体をメモリに置けない。
  `src/lib/asr/capture.ts` が5秒ぶんずつバッファして Rust 側 (`src-tauri/src/capture.rs`) へ生バイナリ IPC で送り、
  `wav::Writer` が16bit PCM で追記する。書き込みに失敗しても録音と逐次文字起こしは続行する（失うのは第2パスだけ）。
  - ヘッダのサイズ欄は **追記のたびに書き直す**ので、ファイルはどの瞬間でも再生可能な WAV になっている。
    クラッシュや電源断で録音を丸ごと失わないため。
  - 保存先はアプリのキャッシュディレクトリ配下 `recordings/rec-YYYYMMDD-HHMMSS.wav`。ファイル名はフロントエンドが
    生成する（Rust だけではローカル時刻を整形できないため）ので、Rust 側で `[A-Za-z0-9_-]` 以外を落として
    パス外への脱出を防いでいる。**自動削除はしない** ので、溜まったら手動で消すこと。
- **第2パスは無音区間のセグメントを音声側の根拠で落とす。** 逐次パスは無音ウィンドウを入口で弾けるが、
  第2パスは会議中の「間」を含む全体を1本で処理するため入口で塞げない。そこでデコード後に、各セグメントの
  区間（前後1秒の余裕込み）の RMS が `SILENCE_RMS` 未満ならそのセグメントを捨てる
  (`asr::drop_silent_segments`)。**判定材料はテキストではなく音声**なので、「はいはいはい」のような正当な発話を
  文面の見た目で消すことがない。前後1秒の余裕は whisper のタイムスタンプが粗いことへの保険（下記 DTW を参照）。
  なお `no_speech_thold` は 0.6 / 0.3 / 0.1 のいずれでもこの幻覚を抑えられないことを実測で確認済み。
- **タイムスタンプは DTW（動的時間伸縮法）で精密化している。** whisper が既定で出すセグメント境界は、
  デコード中にたまたま出た単一タイムスタンプトークンを読むだけの粗い実装で、数百ms ずれることがある。
  `asr::init_model` で `DtwParameters { mode: DtwMode::ModelPreset { model_preset: DtwModelPreset::LargeV3Turbo } }`
  を設定し、アテンション行列を追跡してトークン単位の時刻を求める方式に切り替えている。`large-v3-turbo` 専用の
  プリセットが `whisper-rs` に存在するため、モデルに合わせてこれを使う。話者分離の話者割り当ては時刻の突き合わせに
  依存するため、ここの精度がそのまま効いてくる。制約: DTW は `flash_attn` と併用不可、`new_segment_callback` の
  呼び出しが不整合になるとされているが、**このアプリはどちらも使っていないため影響なし**。
  コストは実測で軽微（40秒音声・Vulkan、3回平均で DTW 無し約3.3秒 → 有り約3.5秒、+4〜5%）。
- **言語は既定で日本語。** whisper.cpp は `"auto"` 指定で真の言語自動検出をサポートする（設定パネルの
  「自動検出」）。既定言語は `src/store/appStore.ts` で ISO 639-1 コード `"ja"` に設定している。
- **マイクは設定パネルから選べる。** `navigator.mediaDevices.enumerateDevices()`（`src/lib/audio/devices.ts`）で
  列挙するが、**デバイスラベルはマイク権限を許可するまで空文字列になる**（ブラウザの仕様。フィンガープリンティング
  対策）。許可前は「マイク 1」のような仮ラベルで表示し、録音を一度開始してマイク権限が確定した時点で
  再列挙して本来のラベルに差し替える。保存したデバイスが録音開始時に見つからない場合（USB マイクを
  抜いた等）は `OverconstrainedError` を捕まえて既定のマイクにフォールバックし、その旨を通知する
  （`src/lib/audio/pcmRecorder.ts` の `usedFallbackDevice`）。`devicechange` イベントも購読しており、
  抜き差しに応じて一覧が自動更新される。
- **相手（Teams/Zoom 等）の音声は WASAPI プロセスループバックで取り込む。** マイクだけでは自分の声しか録れず、
  ヘッドセット利用時は相手の声が一切記録されない。これを解決するため、指定したアプリが再生している音声だけを
  対象に取り込む（`src-tauri/src/appaudio.rs`）。
  - `Chromium` の `getDisplayMedia` は Windows では画面共有のタブ音声かシステム全体の音声しか取れず、
    **ネイティブアプリのウィンドウ単位の音声取得はできない**。代わりに Win32 の
    `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`（[`wasapi`](https://github.com/HEnquist/wasapi-rs) クレート
    の `AudioClient::new_application_loopback_client`）を使い、指定した PID（と `include_tree: true` でその
    子プロセスも）が再生する音声だけをキャプチャする。要件は Windows 10 build 20348 以降（このアプリの
    動作環境なら通常問題ない）。
  - **対象アプリの一覧は「今まさに音を出しているプロセス」からしか作れない。** `IAudioSessionManager2` の
    アクティブなオーディオセッションを列挙して PID を取得し、`QueryFullProcessImageNameW`
    （`windows` クレート。`wasapi` が既に依存しているので追加コストなし）で実行ファイル名に解決する。
    Windows が「音を出す可能性があるプロセス」ではなく「今セッションを持っているプロセス」しか教えてくれない
    ため、**Teams/Zoom は通話に参加してから一覧に現れる**。UI に更新ボタンを置いているのはこのため。
  - **16kHz mono への変換はリサンプラを自前で書かず WASAPI 自身にやらせている。** `wasapi` の
    `StreamMode::EventsShared { autoconvert: true, .. }`（`AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`）は、
    プロセスループバックモードでも機能することを自プロセスでのトーン再生＋キャプチャで実測確認済み
    （48kHz ステレオ → 16kHz モノを要求してそのまま通った）。当初計画していた `rubato` は不要と判断し、
    依存に加えていない。
  - **アプリが無音の間、プロセスループバックは何もデータを返さない。** 放置するとマイクとの時間軸がずれるため、
    キャプチャループは経過時間を基準に一定間隔（100ms）でチャンクを送り出し、実際の音声が足りない分は無音で
    埋める（`appaudio.rs` の `flush_due_chunks`）。自プロセスでの実測では、5秒間キャプチャして
    受信サンプル数が期待値の 99.97%、`implied duration` が 5.00秒（期待5秒）と、時間軸のズレをほぼ解消できている。
  - **マイクとの合流はフロント側で行う。** マイクは既存どおりブラウザの `getUserMedia`（エコー除去/ノイズ抑制/AGC
    を保持）、アプリ音声は Rust から Tauri の `Channel`（生バイナリ IPC）で届く。両者を Rust 側で混ぜず
    フロントで合流させているのは、逐次文字起こしの chunk-and-commit ロジック（`StreamingTranscriber`）を
    Rust に移植するより、そちらを変えずにアプリ音声を引き上げるほうが小さく安全なため。合流は
    `src/lib/audio/mixer.ts` の `AudioMixer` が担い、**マイク側のフレームが基準（ペースメーカー）**。
    マイクフレームが来るたびに、その時点でキューにあるアプリ音声を同じ長さだけ取り出して合成し、足りなければ
    無音で埋める。片方だけがクリップしないよう、各ソースを 0.7 倍してから加算する（両方が同時に最大振幅でも
    1.4 倍で収まり、まれに超えた分だけ clamp する）。
  - **アプリ音声の取得は失敗しても録音全体を止めない。** 開始時に失敗すればマイクのみで録音を続け、
    録音中に対象アプリが終了する等で失敗すれば以降マイクのみに切り替わる（`asr:app-audio-error` イベント）。
    いずれも `refineNotice` で理由を表示する。
- **音響イベント検出も話者分離と同じく、録音全体を見る停止後の別パスとして実装している。** 逐次パスの
  15秒ウィンドウでは「この10秒は音楽か」の判定に使える文脈が足りない、というのが主な理由（`src-tauri/src/events.rs`）。
  診断（`diarize_recording`）・除外判定（`detect_audio_events`）とも Rust 側の Tauri コマンドで完結し、
  フロントエンドは `chunks`（`nonBlankChunks(result).map(c => c.timestamp)`）を渡して `exclude: boolean[]` を
  受け取るだけ。話者分離の `diarizeRecording` と全く同じ「同じ 0-based タイムライン上で、`chunks` と同じ順序の
  配列を返す」という契約に揃えてあり、`appStore.ts` の `refineRecording` でも両者は隣り合わせで同じ `targets`
  を共有して呼ばれる。
  - **除外されたチャンクは `segmentsFromResult` の中で消える** (`src/lib/transcript.ts`)。話者分離のように
    `speaker: null` を持つ空のセグメントを残すのではなく、そのチャンクの分だけセグメントが生成されない。
    ただし ID は `startId + i`（`i` はフィルタ前のチャンク index）のままなので、次の録音の ID がここで
    飛んだ番号と衝突しないよう、`appStore.ts` 側では `refined.length` ではなく元のチャンク数ぶん
    `nextSegmentId` を進めている。
  - **「聞き直し推奨」マーカーは文字起こしセグメント側には持たせていない。** 音響イベント欄
    (`AudioEventPanel.tsx`) がイベントのラベルを見てその場で音楽/ノイズ系かどうかを判定し、該当行にだけ
    バッジを出す。文字起こし本文を汚さないという方針（本節冒頭）を UI 側でも徹底するため、専用のフラグを
    フロントの型に足すより、既に持っている生イベントから都度導出する方を選んだ。
  - **音響イベント欄も `segments` と同様、開始→停止のたびに累積する。** ただし専用のカウンタは持たず、
    新しい結果を差し込む直前に「今回の録音の開始時刻より前のイベントだけ残す」フィルタ
    (`e.start < baseSec`) をかけている。録音のタイムラインは常に単調増加するため、これだけで前の録音の
    イベントを壊さずに今回の分を差し替えられる。
- **精度のための設定。** デコードはビームサーチ（`beam_size` 5、whisper.cpp CLI と同じ既定）。温度が既定の 0.0 では
  greedy の `best_of` は効かず単なる argmax になるため、ここは明確な差になる。`suppress_nst` で「(音楽)」等の
  非音声トークンも抑制している。
- **無音のウィンドウはモデルに渡さない。** `StreamingTranscriber` は RMS が `SILENCE_RMS`（`src/lib/asr/diagnostics.ts`）
  を下回るウィンドウを文字起こしせず読み飛ばす。whisper に無音を渡すと定型句（「ご視聴ありがとうございました」）を
  でっち上げたり「なぜなぜなぜ…」のような反復ループに陥る。**特に録音停止時に頻発する** — 停止ボタンを押すまでの
  間が端数ウィンドウとして強制的に文字起こしされるため。出力側でテキストを見て弾く方法は「はいはいはい」のような
  正当な発話を消す危険があるので、入力側で塞いでいる。閾値は保守的に設定してあり、それでも幻覚が残る場合は
  `logPcmStats` が毎ウィンドウ出力する `rms=` を静かな区間で確認し、その直下まで上げること（当て推量で上げない）。
- **反復ループ対策に `entropy_thold` を 2.8 へ引き上げている（既定 2.4）。ただし短い反復には効かない。**
  判定が `result_len > 32 && entropy < entropy_thold`（whisper.cpp:7527）とトークン数で足切りされているため、
  「なぜ」×13 程度の短いループは**判定自体が実行されない**。短い反復は上記の無音ゲートで入口を塞ぐ方が確実。 Whisper は同じ語句を延々と出力し続ける
  degenerate loop に陥ることがある。移行前の transformers.js 実装は `no_repeat_ngram_size: 3` でこれを抑えていたが、
  whisper.cpp に同等のパラメータは無い。代わりに `result_len > 32 && entropy < entropy_thold` で高温度リトライへ
  フォールバックする仕組みがあるので、その閾値を上げている（実測で entropy 2.60 のループが既定値 2.4 を素通りした）。
- **やってはいけないこと: 確定済みテキストを `initial_prompt` として次ウィンドウに渡す。** 表記の一貫性という点では
  魅力的だが、生成結果を入力に戻す構造は反復ループを自己増幅させる。実際に試したところ同じ語句が繰り返し出力される
  不具合が再現したため撤去した。**ユーザーが書いた固定の用語集を渡すのは別物で、これは安全**（自己増幅しない）。
  `initial_prompt` そのものが危険なのではなく、モデルの出力を自分の入力に戻す閉ループが危険という区別。
- **推論は Vulkan で GPU 実行する。** `whisper-rs` の `vulkan` feature を有効にしている。これは連動して
  内部の `_gpu` feature を立て、`WhisperContextParameters::default()` の `use_gpu` を `true` にするため、
  コード側で GPU を明示する必要はない。CUDA/HIP ではなく Vulkan を選んだのは、ベンダーを問わず動くため
  （このマシンは Intel Arc 内蔵 GPU）。起動ログに `whisper_backend_init_gpu: using Vulkan0 backend` が出れば
  GPU で動いている。`no GPU found` なら CPU にフォールバックしている。
  実測（30秒ウィンドウあたりのエンコーダ処理時間、Core Ultra 7 155H + Intel Arc 内蔵 GPU）:

  | 構成 | 時間 |
  |---|---|
  | CPU・最適化フラグ欠落時 | 223 秒 |
  | CPU・最適化修正後 | 27 秒 |
  | **Vulkan GPU** | **約 2 秒** |

  30秒の音声を約2秒で処理できるため、録音しながらの逐次文字起こしが十分な余裕を持って成立する。
- **whisper.cpp / ggml のネイティブログは既定で抑制している。** 放っておくとモデル情報の羅列に加え、
  ウィンドウごとに `whisper_init_state:` が7行ずつ出て有用な情報が埋もれる。`whisper_rs::install_logging_hooks()`
  で `log`/`tracing` 側へ流しており、どちらのバックエンド feature も有効にしていないので実質破棄される。
  モデルのロードや GPU バックエンドの問題を調べるときは環境変数 `WHISPER_VERBOSE=1` を設定すると元に戻る。
- **WebView2 のキャッシュ破損に注意。** 開発中にプロセスを強制終了すると、WebView2 のディスクキャッシュに
  不完全なレスポンスが残り、後続の起動で予期しないエラーが再発することがある。発生した場合は
  `%LOCALAPPDATA%\com.hiroo.whisper-scribe\EBWebView` を削除してから再起動する。

## 推奨 IDE 設定

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)

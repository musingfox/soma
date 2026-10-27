# soma 架構與規劃

soma 是一個個人助理核心：它接收各種介面傳來的話，調派本地的 coding agent 去做事，等待期間不花 token，最後把結果整理成報告。

名字取自神經元的細胞體：它從樹突收集訊號、整合之後，再經軸突送出去。

狀態：M0 到 M3.5 的程式碼已在 main（2026-10-18），真模型、Telegram 手機端與 Google 帳號的人工驗收於 2026-10-22 跑完，見各 obw 任務卡的 Notes。本文件的外部事實查證於 2026-10-18，並經三份獨立複核（Pi 原始碼、cc-mobile 原始碼、外部文件）修正過引用。

出處縮寫：

- **Pi 的路徑** 指 [earendil-works/pi](https://github.com/earendil-works/pi) commit c268154 的 `packages/` 底下。`spec` 是 `durable/docs/spec.md`，`README` 是 `durable/README.md`。單寫 `types.ts`、`scheduler.ts` 時，分別指 `durable/src/types.ts` 和 `durable/src/harness/scheduler.ts`。
- **cc-mobile 的路徑** 指 `~/workspace/cc-mobile` commit d9f0690。

## 要解決的問題

1. **agent 給的訊息太原始。** cc-mobile 轉給手機的是 agent 自己說的話，使用者要的是跨工作整理過的報告。
2. **讓 agent 自己定時監控太貴。** 每一輪輪詢都是一次模型呼叫，還得一直保留一個 session。
3. **介面各自長大腦。** shikigami 有自己的大腦（`brain.rs`、`backend*.rs`、`tools.rs`、`memory.rs`），cc-mobile 沒有。再加上 Telegram，就會出現第三套。

## 整體形狀

```
           人類側介面                         agent 側介面
  ┌──────────────────────┐            ┌──────────────────────┐
  │ Telegram（程序內）     │            │ rex                  │
  │ shikigami（客戶端）    │──▶ soma ──▶│ herdr                │
  │ 終端機（開發用）        │   核心      │ 原生 tty（M6）         │
  └──────────────────────┘            │ ACP、HTTP（之後）       │
                                      └──────────────────────┘
```

- **核心是一個常駐程序。** 它以 [Pi Durable](https://earendil.com/posts/pi-durable/) 為 harness，用 SQLite 儲存。同一份儲存只能由一個程序擁有，儲存層本身不擋第二個程序（README:688）。soma 啟動時以 db 父目錄的 realpath 加檔名取得 chord 的 `processLock`（`chord/dist/manager.d.ts:66-72`、`src/core/harness.ts` 的 `acquireDbLock`），第二個程序印出 `[soma] ...` 並以狀態 1 結束。`kill -9` 後舊 socket 檔沒人接聽，下一個程序會接管（`chord/dist/manager.js:37-44`），但這是先檢查再刪檔，不防兩個程序在同一刻啟動。socket 檔放在 `os.tmpdir()` 底下，路徑太長時改放 `/tmp/chord2-<uid>/`（`chord/dist/manager.js:69-80`），所以 `TMPDIR` 不同的兩個程序拿到的是兩把鎖；之後寫 launchd 的 plist 時，要把 `TMPDIR` 設成和終端機相同的 `getconf DARWIN_USER_TEMP_DIR`。
- **啟動順序。** 重啟後排程器不會自動恢復，要先呼叫 `harness.resume()`，否則背景任務和排隊中的輸入都不會動（`durable/src/harness/types.ts:716-720`）。接著事件橋做一次對帳：抓 herdr `agent.list` 和派工清單比對，補上核心停掉期間發生的狀態變化。M1 和 M2 的驗收都靠這一步。
- **所有介面共用一個根對話（`harness.root()`）。** 在 Telegram 交代的事，回到桌面問也接得上。每則輸入用 `entry.kind` 標記來源，例如 `chat.telegram`、`voice.shikigami`。模型看不到 `entry.kind`，只看得到 `content`（spec:2318-2320、README:427），所以來源若要讓模型知道，得寫進內容。
- **核心只產出一份回答，怎麼呈現由介面卡決定。** shikigami 念短版，Telegram 傳文字。
- **回答怎麼分送。** 根對話共用，每個介面卡都看得到所有輪次。規則是：介面卡只送出由自己的 `requestId` 啟動的那一輪回答；報告經 `notice` 紀錄分送；其他輪次只當歷史。這條規則寫在介面卡裡，不寫在提示裡。

### 分層與依賴方向

採 ports and adapters（shikigami 已經是這個形狀）。目標只有一個：新接一種介面時，只新增一個介面卡模組，不改核心。

```
  人類側介面卡 ──▶ HumanPort ──▶ 核心（領域 + Pi Durable extension）──▶ AgentPort ◀── agent 側介面卡
  telegram/ shikigami-socket/ terminal/                            herdr/ rex/ acp/ http/
```

- **核心只依賴兩個 port 的型別**，不 import 任何介面卡；介面卡只依賴 port，不互相 import，也不碰 Pi Durable 的型別。Pi Durable 的 `Conversation`、`Entry`、`Harness` 只出現在核心內部。
- **HumanPort** 就是「人類側契約」那四個動作：送出、訂閱、通知、回答提示。核心暴露的是 soma 自己的事件型別（回答、失敗、通知、派工狀態、根對話這一輪是否在跑），不是 Pi 的 `watch()` 原始事件；程序內和程序外的介面卡拿到的是同一套型別，差別只在中間多一條 socket。
- **AgentPort** 就是「agent 側契約」那六個動作，狀態用 OSC 7501 的詞彙。port 和核心不帶任何一種 agent 介面的名字，所以 herdr、rex、ACP 都只是可以互換的實作，別人也能為自己的終端寫一個。使用者在設定裡選要用哪一個，各實作的能力差異見「agent 側介面卡的能力差異」。
- **領域物件在核心**：派工清單、工作狀態機、報告。它們是純 TypeScript，不知道 Pi Durable 的存在；Pi Durable extension 是把它們掛進 harness 的那一層。
- **測試縫**：M1 的 `kill -9` 驗收用真 herdr；其餘單元測試用記憶體內的假 AgentPort 和假 HumanPort，不碰 socket。

不做的是通用的外掛框架：沒有介面卡註冊表、沒有動態載入、沒有為尚不存在的介面預留的設定格式。port 是兩個 TypeScript interface，介面卡是直接 import 進 `main.ts` 組裝的模組。

### 兩種互動不能混在一起

- **跟助理對話**：派工、問進度、看報告。這部分由 soma 負責。
- **直接操作某個工作 agent**：鏡像 session、按權限提示。這部分不經過 soma 的 LLM，否則按一下核准也要先跑一輪模型推理。模型轉給人的權限提示，人可以在 Telegram 按按鈕回答，由核心直接送給 agent（見「回答提示」）。鏡像 session 和其他直接操作由終端自己的客戶端負責，不經過 soma；2026-10-18 時這部分由 cc-mobile 的 herdr 直通負責，2026-10-24 起不再需要 cc-mobile（見「已決事項」）。

## 核心的組成

用 Pi Durable 的元件來對應，每個元件都是一個 extension。

| 元件 | Pi Durable 機制 | 說明 |
|---|---|---|
| 派工清單 | document（對話層級） | 記錄每件工作的卡片、agent 名稱、session id 和狀態，和對話紀錄在同一筆提交裡更新 |
| 派工工具 | tool，`replay: "safe"` | agent 名稱取卡片名，啟動前先查派工清單和同名 agent 是否存在，崩潰後重跑也不會重複啟動；詳見「派工的冪等」 |
| 查詢與讀取工具 | tool，`replay: "safe"` | 列出 agent、讀對話紀錄 |
| 回應工具 | tool，不可重跑 | `respond` 回答卡住的 agent，`escalate` 轉給人，`reply` 把人的回答送給結果為「需要你」的 agent；三者都把判斷和理由寫進派工清單。崩潰中斷時會告知模型，不會自動重送（spec:2944、3393-3397） |
| 事件橋 | 主機端程式碼，不是 LLM | 見下節 |
| 排程 | tool + 背景任務 | `schedule(at, instruction)` 建一個睡到 `at` 的背景任務，時間到送一則 input（`requestId: schedule:<id>`）；定時彙報是它的一個固定實例。見「定時彙報」 |
| 記憶 | section + document + tool | 移植 shikigami 的設計，見下節 |
| 外部工具 | pi-mcp 轉接層 | email、行事曆等能力以 MCP server 接入，核心不為任何一種服務寫專用碼。Exception (2026-10-27): read-only tools whose output soma must shape, such as web search, may be core extensions; see「已決事項」. 見「助理基本能力」 |

### 根對話的壓縮

根對話所有介面共用、永不結束，所以遲早會長到觸發自動壓縮（未實測，見本節最後一點）。pi-durable 1.3.0 預設開啟自動壓縮，門檻是 `reserveTokens: 16384`、`keepRecentTokens: 20000`、`backgroundTokens: 32768`（`node_modules/@earendil-works/pi-durable/dist/harness/agent.js:10-15`）。`src/core/harness.ts` 沒傳 `settings`，所以用這組預設值。門檻依模型的上下文長度計算，soma 沒有需要不同門檻的情境。本節的 `pi-durable/README.md` 指 node_modules 裡 1.3.0 版的檔案，行號和 Pi repo 的 `durable/README.md` 不一定相同。

- 壓縮把較舊的紀錄摘要成一筆 `pi.compaction` entry，舊紀錄仍留在儲存裡（`pi-durable/README.md:456`）。摘要在對話繼續運作時產生，不是一輪，所以不算進「定時彙報」一節的叫醒次數。
- 讀舊紀錄的功能不受影響。`inspect`、`recall` 和 `mark_denied` 用 `tx.scanEntries` 掃儲存，反省讀事實層的文件（`src/core/extensions/reflection/index.ts:66`），都不經過模型看到的上下文。
- 摘要的花費記在 `pi.usage` 文件（`pi-durable/README.md:482`、`dist/harness/compaction.js:139`），不在 assistant entry 裡。`inspect` 的 `usage` 只加總 assistant entry（`src/core/extensions/inspect/index.ts:174-196`），所以查不到壓縮的花費。
- 一輪在阻擋門檻等的壓縮失敗時，這一輪也失敗，input 以 `model_error`、`Compaction failed: <error>` 結束成 `unanswered`（`pi-durable/README.md:484`）。這走一般的失敗路徑：HumanPort 發 `failure` 事件並記結果訊號，`inspect` 的 `failures` 查得到。
- **未驗證：** 根對話長到觸發壓縮的情況沒有冒煙測試。本節是讀文件和程式碼得出的，沒有實際跑過。

### 事件橋：監控不花 token

事件橋放在 harness 外面，訂閱 herdr 的事件，用規則決定怎麼處理，不呼叫模型：

| 事件 | 處理方式 | 叫醒模型嗎 |
|---|---|---|
| agent 卡住（blocked） | Submits an `input` to the root conversation with `requestId` `agent:<agent>:<seq>`, unless its prompt is the one last handed over (see the seq point below) | 會。模型自行判斷要代答還是轉給人。`kind=auth` 例外：不叫醒模型，事件橋在提交 seq 的同一筆 commit 裡寫一筆 `notice`（question）給人，並記一筆 escalated 判斷。每次判斷連同理由寫進派工清單，彙報時一併列出，讓人事後能檢查它的判斷 |
| agent 做完（進入 idle 或 done） | Recorded once per transcript end: a turn whose transcript's last record is the one already recorded is not recorded again (see the seq point below). 用 `conversation.commit` 寫進派工清單並追加紀錄。結果是「需要你」或「失敗」，或是「完成」而人十分鐘內親自選過選項或回覆過這件工作，就在同一筆 commit 寫一筆 `notice` 給人，內容是 agent 回覆原文；「需要你」用 question，其餘用 report（`src/core/domain/report.ts` 的 `urgent`） | 不會 |
| 使用者主動詢問 | 由介面卡送出 `input` | 會 |

事件橋和 harness 在同一個程序裡，只是不在 LLM 迴圈裡；它需要直接呼叫 `conversation.commit`。

已查證的依據：

- **`write` 和 `commit` 都不會啟動一輪推理。** 出處是 pi `packages/durable` 的規格 spec:2343-2355 與 README:421。例外是對話閒置、收件匣卻還有排隊項目、而且這筆 write 不是純顯示用時，才會補跑一輪（spec:2363-2367）。
- **`requestId` 在整個對話範圍內去重**（spec:2358）。根對話共用，所以每個來源要有自己的前綴：`agent:<agent>:<seq>`、`telegram:<msgid>`、`digest:<until>`。
- **光靠 herdr 的事件流不可靠。** cc-mobile 另外用 `session.snapshot` 補洞，靠 `state_change_seq` 判斷狀態是否真的變過。計時器每秒一拍，但 snapshot 的頻率依聽眾分級，每 1、3、5 或 30 拍一次（`server/herdr/pane-events.ts:77, 94-98, 436-458`）。事件橋要照做。所以監控不花 token 是靠程式輪詢，而不是單靠事件推送。
- **派工的第一則提示由事件橋送出，不在 `agent.start` 之後立刻送。** 2026-10-18 對 herdr 0.9.5 實測：`agent.start` 剛回應時 `agent.prompt` 回 `agent_not_ready`；把提示放進 claude 的啟動參數，herdr 以 `invalid_agent_argument` 拒絕；新 repo 的 claude 先停在資料夾信任對話框（herdr 回報 blocked）。所以派工工具只把提示（cc-mobile `server/launch-prompt.ts` 的規則加卡片內容）存進該筆工作，事件橋第一次看到 agent 進入 idle 時才送出。看到 working 或 done 就丟掉沒送的提示，因為那表示已經有人給了它工作，這也避免崩潰重啟後重送。
- **seq names an observation; it does not count transitions.** Every status an agent-side adapter reports carries a seq, with one rule for every adapter (`src/ports/agent.ts`): the same value is the same observation, and a new value does not promise the agent went through a transition. herdr sends its `state_change_seq`; rex sends the root record's `updated_at` in microseconds since the epoch, parsed from the timestamp's full fraction (rex reports to the microsecond, e.g. `2026-10-26T23:23:54.388938+08:00`), not `Date.parse`, which keeps milliseconds and would merge two reports within one; it is stable for one report, since rex re-sends `program_status_changed` whenever anything in the record changed. The dispatch list keeps the last seq each job handled, and an observation carrying that seq again (a repeated snapshot, a listing with a seq at the reconciliation after a restart) does nothing. A new seq acts only on what changed (`src/core/domain/bridge.ts`):
  - **blocked** wakes the model (or escalates, for `kind=auth`) unless its prompt is the one last handed over. The job stores the `fingerprint` and `msg` of the block it last handed over (`Job.handedOver`), in the commit of the seq that woke the model or escalated, and forgets it when a status other than blocked is folded in, by the bridge or by the reconciliation. A blocked observation whose fingerprint and msg match the stored ones only records the seq. The rule does not compare against the job's stored status, because that status is not always one the bridge handed over: the reconciliation after a restart writes it straight from `list()`, and herdr's listings carry no seq, so they never go through the bridge; the dispatch tool writes the listed status of an agent it found already running. A block that first appeared while soma was down, or a trust dialog a rerun dispatch found, is therefore handed over at the first snapshot that reports it.
  - **done or idle** after a turn reads what the agent's transcript ends on (`readResult`, M5-2d). A completion's identity is the transcript's last record, whoever wrote it: `AgentResult` is `{ id, text? }`, where `id` is the `uuid` of the conversation's last record that carries one, the user's prompt, a tool result or the assistant's reply, and `text` is the final reply, present only when the transcript does not end awaiting one (`readLastRecord` in `src/agent-cli/transcript.ts`, which herdr and rex share). `complete` records a finished turn only when that id differs from the one the job stored with its last recorded turn (`Job.resultId`), or none is stored yet; the outcome comes from `text`, and a transcript that ends without a reply, an interrupted turn or one ended by a denied permission, is recorded with outcome 未知 under its own last record. A transcript that cannot be read at all, or holds no record with an id, is still recorded with outcome 未知 and leaves `resultId` alone. So a re-reported done or idle is recorded once, whether the turn ended on a reply or on the user, and a second turn between two samples, with no working seen in between, is recorded because its last record is new. Checked against real transcripts on 2026-10-27: `uuid` is on every `user` record, tool results included, and every `assistant` record (one per content block), but also on the `system` (`turn_duration`, `stop_hook_summary`) and `attachment` records claude writes after a turn; those, and the sub-agent, injected and compaction records, are not counted, since one written after the turn was read would name a second turn. Before M5-2d the id was the last assistant message's `message.id`, and every undefined read was a new turn: a turn that ended on the user recorded another 未知 turn at each re-stamp of its idle or done (about 40 of 600 recent transcripts ended on a user record).
    Accepted edges (accepted by the human on 2026-10-27). (a) A turn claude has not written at all when rex's `replyMs` (2 s; see「rex 的實作」) passes is not recorded at its end: the read at the timeout returns the turn before's last record, which the job already holds. It is recorded at the re-check 10 s later (below), or at a later re-stamp, read at once. (b) A final reply split over a thinking record and a text record, read between the two, records 未知 under the thinking record's id and then the real outcome under the text record's, since claude writes one record per content block, each with its own `uuid`. Such a read happens where nothing waits for the reply: herdr's, the startup reconcile, and rex's when the watch does not know the turn's end. rex's wait for a known end does cover it: a last record holding only thinking counts as the reply not yet written (`awaitingReply`), so the wait goes on until the text is out or 2 s pass. The slow-flush cases, accepted by the human on 2026-10-27 with the re-check as their recovery: a session's first turn read before its transcript exists (`undefined`, recorded without a reply id), a turn only part written at the timeout (its prompt but not its reply, recorded under the prompt's id), and a reply whose text is written more than 2 s after its thinking (recorded under the thinking record's id) each record 未知 and then the real outcome, at the re-check 10 s later or at a rex re-stamp. A turn still unwritten at the re-check stays recorded as 未知 until a re-stamp; the next digest reads the reply into its report, without changing the recorded outcome. The re-check (M5-2f, rex only): when `readResult` returns because `replyMs` passed, whatever it returns, the adapter re-reads the block's root `program_status` record `recheckMs` (10 s) later, through the watch's queue, so it is ordered with real reports. It reports again when, since that read, the watch has reported no `working` and no `blocked` for the block (only done, idle or error, under any `updated_at`), the block is still in the hangar, claude is in the foreground, and the root record is now done, idle or error; it emits that record's status under the block's last emitted seq + 1. A done that settled into idle before the re-check is the usual end of a turn, and the re-check reports the idle. `track` takes the report as one with no `working` seen, so `turnEnded` is cleared and the next read is at once. The core reads where it reads for any report: at a done after a done or an idle, and at an idle after an idle; there a new last record records the real outcome, with its notice as for any completion, and the same id records nothing. A re-emitted idle after a done the core holds reads nothing, and the turn is read at the real idle event that follows, without waiting; a re-emitted error never reads. If that idle event is lost (a transient non-claude foreground, a payload failing its schema), only a re-stamp or the next turn recovers the turn. A block that went on to work or to a prompt gets nothing, since the watch reported the end of the turn after it, as does a block closed, left by claude, or whose record is working or blocked by then. The contract author amended this rule on 2026-10-27; the first M5-2f build required the root record to be the very one the watch last reported, same state and `updated_at`. One re-check is pending per block, a newer timeout replacing it, and closing the watch (the last `onStatus` unsubscribed) cancels them. Neither AgentPort nor the core changed. A job whose `resultId` was stored before M5-2d is an assistant `message.id`, which no record uuid matches, so it records one extra completion at its first observation after the upgrade; prod had not been released with `resultId`, so there is no data migration.
  - The wake's input is submitted before the seq and the handed-over prompt are committed. A crash between the two leaves the job as it was before the block, so the redo on restart wakes again under the same seq, as long as the adapter reports the same seq for the same observation, and the same `requestId` returns the first submission. An escalation has no side effect before its commit, so a crash before it simply redoes it.
- **Accepted edge: a repeated question is missed when nothing was observed in between.** If an agent is answered and then asks the identical question again (same fingerprint and msg) while no status other than blocked was observed in between (for herdr, both transitions within one poll), the model is not woken for the second ask. Any observed non-blocked state in between, working included, whether by the bridge or by the reconciliation, makes the next block wake the model again. Detecting this case would need a transition counter, which rex does not have and an adapter cannot keep across a soma restart.
- **agent 卡住的通知用 `whenBusy: "followUp"`，不用 `steer`。** soma 正在跑一輪時，通知要等整輪結束才處理（`src/core/extensions/dispatch/bridge.ts:69`）：pi-durable 1.3.0 只在一輪的最後邊界取出 followUp，steer 則在每個工具回合結束時就取出（`node_modules/@earendil-works/pi-durable/dist/harness/inbox.js:45`）。不用 steer 的理由是它會和原本那一輪共用回答：steer 的 input 被加進同一輪（`dist/harness/generation.js:538-539`），一輪結束時每個 input 都結算成同一個 `answer`（`dist/harness/live.js:27-30`）。後果有三個。併進使用者在 Telegram 問的那一輪，手機收到的回答會夾著代答內容，不再是「回答怎麼分送」一條要的一輪一份回答。併進彙報那一輪，彙報任務會把代答寫進報告通知（`src/core/extensions/digest/index.ts:142-147`）。合併的那一輪失敗時，HumanPort 對每個 input 各發一次失敗（`src/core/human-port.ts:78`），人會收到自己那一輪的失敗回覆，再加上 `agent:` 經 `PUSHED_FAILURES`（`src/ports/human.ts:16`）推出的第二則。steer 只省下等一輪結束的時間，換不回這些代價。

### 派工的冪等

派工走 herdr 介面卡（待決事項 1 的決定），agent 名稱就是卡片名。2026-10-18 對 herdr 0.9.5 實測：`agent.start` 一回應，`agent.list` 就列出這個名稱（`launch_pending: true`）；同名的第二次 `agent.start` 會被 herdr 以 `agent_name_taken` 拒絕。因此：

- session id 由派工工具先用 `api.memo` 存下再交給 `agent.start`，因為 claude 回報 `agent_session` 之前，herdr 讀不到它。
- 重跑時先查派工清單有沒有這張卡，再查 `agent.list` 有沒有同名 agent。兩處都沒有才啟動。
- 派工清單在工具結果之前另用一筆 `api.commit` 寫入；工具結果的提交由 harness 負責，無法合併。殘餘的空窗是「`agent.start` 已回應、派工清單還沒寫」，重跑會在 `agent.list` 找到同名 agent 而不重啟。`npm run smoke:dispatch` 就打在這個空窗。
- 「`worktree.create` 之後、`agent.start` 之前」崩潰，重跑時改用 `worktree.open` 開回同一個 worktree。

### 定時彙報

用一個背景任務實作，以 `tx.createTask(T, input, { ownership: { kind: "conversation" }, background: true })` 建立。它每十分鐘醒一次，先讀派工清單：自上次彙報以來沒有新完成的工作，就只推進 checkpoint、不叫醒模型；有，才送一則 input 請模型寫一份短報告。所以做完的工作最晚十分鐘內會被回報，而模型只在有東西可報時才被叫醒。事件橋已經馬上通知過的工作不再列進彙報，只剩這類工作時也不叫醒模型。

- **`sleep(until)` 本身不會被儲存。** 它只是記憶體裡的計時器。等待之所以能撐過重啟，是因為 `until` 寫在 checkpoint 裡：重開後任務回到 pending，phase 重跑，時間已過就立刻返回（types.ts:240、scheduler.ts:1816-1827、spec:1930）。
- **每輪都必須推進 checkpoint，否則任務會被判定故障**（spec:1919-1921）。同一個 phase 內只要 checkpoint 內容有變就算推進，所以單一個 `tick` phase 每輪把 `next` 往後推、計數加一就夠了，不必拆成兩個 phase（`durable/test/examples/13-recovery.ts:21-47` 就是這樣寫）。
- **時間到才叫醒模型。** 任務送一則 input 到根對話（`runtime.conversation(id).submit`），帶 `requestId: "digest:<until>"`，否則在送出和 checkpoint 之間崩潰會送兩次。背景任務可以對閒置中的自家對話啟動一輪，範例在 `durable/test/examples/23-subagent-background.ts:108-116`。模型讀派工清單裡這段時間做完的工作，寫成一份報告。
- **「新完成」以事件橋的完成紀錄為準。** 任務讀根對話裡 `soma.dispatch.done` 紀錄，checkpoint 存最後一筆已報過的紀錄 id。不用派工清單的 `seq` 判斷，因為 done 轉 idle 的收尾也會換新 seq，會重報。
- **送出前先釘住範圍。** 送 input 之前，先把這次涵蓋到哪一筆紀錄寫進 checkpoint。否則崩潰後重跑時，中間新完成的工作會被算進範圍，但重送被去重，報告裡沒有它，它就漏報了。
- **報告和下一個 checkpoint 同一個 commit。** 任務等這一輪答完，把回答寫成 `notice` 紀錄，和推進的 checkpoint 一起提交，所以崩潰在哪裡都只會有一份通知。模型這一輪失敗時（例如沒有 API key），通知改放原始的工作清單，這段時間的工作不會因此沒人看到。
- **沒有內建的 cron。** `sleep(until)` 是唯一的計時原語（types.ts:240）。

一天叫醒模型的次數約為「卡住次數 + 有新完成工作的十分鐘區間數 + 使用者主動詢問次數」，和工作跑多久無關。根對話的壓縮另有摘要呼叫，不算叫醒，見「根對話的壓縮」。每次叫醒是一輪（run），一輪內會有多次模型請求，因為工具呼叫會多繞幾回（spec:2335-2338）。

### 報告的資料來源

報告讀工作 agent 的對話紀錄，不抓終端機畫面。

- **找得到紀錄檔。** 派工時以 `--session-id <uuid>` 啟動 claude，紀錄檔位置就是 `~/.claude/projects/<cwd 非英數字元換成 '-'>/<uuid>.jsonl`（cc-mobile `server/transcript/path.ts:56-58`）。編碼路徑沒命中時，`path.ts:90-101` 會掃整個 projects 目錄找。
- **讀取邏輯可以沿用。** cc-mobile 的 `server/transcript/reader.ts` 以位元組偏移量增量讀取；`records.ts:96-123` 只留下 user 和 assistant 兩種紀錄。
- **要自己寫「取出最終回答」。** cc-mobile 沒有這個函式（未全庫搜尋確認）。做法是取 agent 做完後的最後一則助理訊息。cc-mobile 的派工提示（`server/launch-prompt.ts`）要求回覆第一行寫「結果：完成／需要你／失敗」，soma 可以直接解析這一行來分類。

### 助理基本能力

soma 除了調派 agent，本身也要有助理的基本能力：讀 email、看行事曆、記憶、在指定時間處理工作。原則是不為任何一種能力在核心寫專用碼：

- **排程。** 「指定時間處理工作」和定時彙報用同一個機制：模型呼叫 `schedule` 工具，核心建一個背景任務睡到指定時間，到時把指令當成一則 input 送回根對話。等待期間不佔 session、不花 token；週期任務靠每輪推進 checkpoint。排程清單存在 document 裡，模型可以列出和取消。
- **email 與行事曆。** 經 pi-mcp 轉接層接 MCP server，soma 只負責把 MCP 工具掛進 harness。Gmail 與 Google Calendar 用 workspace-mcp，憑證放在 repo 外的 `~/.config/soma/`（待決事項 5 的決定）。對模型來說，這些和派工工具一樣都是工具，差別只在它們不可重跑（寄信不能 replay）。
- **Web search and page fetch.** Two core extension tools, `web_search` (Exa) and `web_fetch` (Defuddle), under the read-only exception decided on 2026-10-27 (see「已決事項」).
- **記憶。** 見下節。因為報告和排程都會用到，記憶要提前到 M2。

### 記憶：移植 shikigami 的設計

照 shikigami `ARCHITECTURE.md`「Persistent state」一節的規則，用 Pi Durable 的元件重做：

- **策展層** 對應一個 section，每次請求前渲染進系統提示。信任程度逐行決定：使用者寫的行直接信任；模型寫的行要加稽核前綴，並放在圍欄內，標成未確認。超過預算就拒絕寫入，不截斷任何內容。
- **策展層可以修訂。** 這是行為層，soma 可以直接改（2026-10-18 使用者的決定）；要改程式碼時則開 obw 卡派進 fleet，soma 自己不能合併。每一行有一個由計數器發的編號，渲染成 `[#編號]`，刪掉的編號不會重發。模型用 `revise_memory` 改寫、`forget_memory` 刪除、`restore_memory` 還原成 `memory_history` 列出的任一版。規則如下：
  - 每次修訂都要附理由和至少一個證據 id，否則拒絕，拒絕原因當工具結果回給模型。只檢查格式，不檢查證據是否存在，因為 Pi Durable 沒有依 id 讀 submission 的 API。
  - 修改前的原文、修訂時間、理由和證據存在同一份文件的 `history` 裡，和改動同一個 commit。歷史不進系統提示，也不算進容量上限；容量上限只算現存的行。
  - 模型改寫過的行一律算模型寫的，即使原文是使用者寫的，所以會加稽核前綴並放進圍欄。還原則照存下來的原樣放回，使用者的原文還原後仍算使用者的。
  - 每次修訂都在同一個 commit 寫一筆 `data.kind: "report"` 的 `notice` 給人，內容寫明改了哪一條、改前改後、理由和證據。不併進十分鐘彙報，因為改錯的記憶從下一輪起就會影響回答，人應該立刻看到。
- **證據 id。** 自我檢視工具回傳的每一筆和記憶修訂引用的證據用同一種格式：`entry:<EntryId>`、`submission:<SubmissionId>`、`task:<TaskId>`，或 `document:<DocumentId>@<Seq>` 表示某份文件在某個 commit 的那一版（Pi Durable 沒有獨立的文件修訂紀錄，一版由文件 id 和 commit 序號決定），或 `decision:<卡片>#<序號>` 表示派工清單裡某張卡的第幾個代答或轉人決定（從 0 起算）。派工清單是 `history: "latest"`，舊版本讀不回來，所以決定不能用 `document:` 引用；決定只會追加，序號不會變。數字都是 Pi Durable 的 id（`durable/src/types.ts:27-36`）。檢查用的正規式是 `src/core/domain/memory.ts` 的 `EVIDENCE_ID`。
- **事實層** 對應一份 document，由程式寫入，不經模型萃取。
- **結果訊號** 存在事實層，種類以 `signal.` 開頭（`src/core/domain/signal.ts`），供自我檢視和反省判斷哪些行為該改。每筆帶一個 key，同一個 key 只記一次，所以崩潰後重跑的寫入不會重複。事件橋在提交 seq 的同一筆 commit 裡記兩種：代答後十分鐘內又卡在同一個 fingerprint 的提示，以及派工結果是失敗或讀不到結果行。HumanPort 看到一輪以 `unanswered` 結束時記一筆。使用者否定上一輪時，模型呼叫 `mark_denied` 標記，紀錄指向被否定那一輪的回答 entry；說明文字由程式產生，模型的話不進事實層。
- **`recall`** 是一個搜尋舊對話紀錄的工具，不呼叫就不花成本。
- **`inspect`** 讓模型唯讀查自己的執行軌跡：失敗的輪次、每輪 token 與成本、代答與轉人、每張派工卡的最後狀態，回傳的每一筆都帶一個 `evidence` 欄位，格式見上面的「證據 id」，超過筆數上限只回最新的幾筆並註明總數。
  - pi-durable 1.3.0 的 `Tx` 和 `Session` 都不能掃 submission，所以這個工具拿 Harness 自己的 `Storage` 來掃，而且只在 `api.commit` 的回呼裡掃：回呼占住 Session 的提交線，讀不到提交到一半的狀態，和 `Tx` 的讀取一樣。
  - 每張派工卡的證據是它的完成紀錄（`soma.dispatch.done` entry）；還沒完成的卡，證據是記下這份工作的那次 `dispatch` 工具結果 entry。派工清單本身讀不回舊版本，所以不用 `document:` 引用。

### 反省

soma 每天讀一次自己的結果訊號，改進自己（`src/core/extensions/reflection/`）。權限照 2026-10-18 的決定：行為層直接改，程式碼開卡派工，soma 不合併任何東西。

- **做法和定時彙報相同**：背景任務的 checkpoint 存下次時間和事實層讀到第幾筆（事實層只追加，所以用位置當游標），送出前釘住範圍，模型的回答和下一個 checkpoint 同一個 commit 寫成 `notice`。不用 `schedule` 工具的提醒任務，因為它時間到一定叫醒模型。`requestId` 是 `reflection:<until>`，介面卡不另外推這一輪，理由同 `digest:`。
- **沒有待處理的訊號就不叫醒模型。** 待處理是指游標之後的 `signal.*`，再扣掉已經處理過的問題。
- **同一個問題只交給模型處理一次。** 每筆訊號歸到一個問題：有卡片的以卡片為準；失敗的輪次以失敗原因為準，原因是 reason 加上 detail，再把 uuid、字母數字混合的長 id 和五位數以上的數字抹掉（`src/core/domain/signal.ts` 的 `failureCause`），所以兩次 401 是同一個問題，401 和 429 是兩個；其他每筆各自一個。某個問題的證據只要被任一筆記憶修訂或反省開的卡引用過，就算處理過了。這是程式的規則，不靠模型自己記得。
- **處理過的問題又出現時通知人，不叫醒模型。** 這代表先前的處理可能沒有奏效，再讓模型修訂或開卡容易越改越亂，所以由程式寫一筆 `notice` 給人，寫明是哪個問題、先前是哪幾筆修訂或哪張卡，以及新訊號的證據 id。通知和推進游標在同一個 commit。同一筆修訂或同一張卡最多通知一次（已通知的記在反省文件的 `alerted`）；之後對這個問題再做新的修訂或開新卡，新的處理沒奏效時會再通知一次。
- **訊號換成證據 id。** 代答後又卡住的訊號沒有自己的 entry，所以 refs 另記那次沒奏效的代答在派工清單的序號，引用成 `decision:<卡片>#<序號>`；失敗的輪次引用 `submission:`，其他引用 `entry:`。反省的輸入也列出相關卡片的每個代答與轉人決定，讓模型能引用整串。
- **要改程式碼時**，模型呼叫 `open_card`，在 soma 自己 repo 的 obw 專案開一張 todo 卡，同一個工具接著把卡派進 fleet（和 `dispatch` 工具共用 `startJob`），再通知人。派工失敗時，工具結果告訴模型失敗原因，通知也寫明卡片停在 todo。兩步放在同一個工具裡，是為了不讓模型開了卡卻忘了派。建卡照 obw pm 的慣例：`create template=task`，property 一次設一個。2026-10-19 對 obsidian CLI 實測兩件事。第一，帶模板時 `content` 會被忽略，所以正文要讀回填好的模板再 `create overwrite`。第二，對已存在的路徑再 `create` 不會失敗，而是另建 `<卡片> 1.md`，所以建之前先 `read` 確認不存在。卡片正文寫入工具呼叫的 call id，崩潰後重跑時，工具認得這張卡是自己開的。
- 冒煙測試：`npm run smoke:reflection` 在等待中和反省那一輪各 `kill -9` 一次；`npm run smoke:reflection-card -- <repo>` 用真 obsidian 和真 herdr 開卡派工，再把卡、worktree 和分支刪掉。

## 兩份契約

### 人類側（介面卡 → 核心）

- **送出**：`submit({ type: "input", content, entry: { kind: "<來源>", data }, requestId })`。`requestId` 用該平台的訊息 id，重送也只會處理一次。終端機沒有訊息 id，用 `terminal:<毫秒時間戳>`：`requestId` 在整個對話內去重，重啟後從 1 重新計數會把新輸入當成重送吞掉。
- **訂閱**：程序內的介面卡經 `src/core/human-port.ts` 的 HumanPort 訂閱，它把 `watchEvents()` 和派工清單的 `watchDoc()` 轉成 soma 的事件型別；派工狀態取自派工清單，所以誰寫進清單，介面卡就看得到。程序外的客戶端改經客戶端 socket 連入。
- **通知**：核心要主動找人時（卡住或報告寫好），寫一筆帶 `kind: "notice"` 的紀錄，`data.kind` 是 `question`（卡住要人回答）或 `report`（報告寫好），各介面卡自己決定要不要推播。由 `schedule:` 開頭的 `requestId` 啟動的那一輪回答，介面卡也當成通知推給人。`digest:` 那一輪不推，因為彙報任務會把它的回答寫成 `data.kind: "report"` 的 `notice` 紀錄，再推一次就重複了。
- **回答提示**：模型用 `escalate` 轉給人的提示，若 agent 側讀得出選項和指紋，`question` 通知會帶 `data.choices`（卡片、指紋、選項），介面卡可以讓人直接選。人選了之後，介面卡呼叫 HumanPort 的 `respond(card, { option, fingerprint })`，核心直接呼叫 AgentPort 的 `respond`，不跑模型（見「兩種互動不能混在一起」），送出後在派工清單記一筆 `answered`。指紋不符時不送鍵，回傳的拒絕原因由介面卡轉給人。Telegram 把每個選項畫成一顆 inline 按鈕，`callback_data` 是 `<選項>:<指紋>:<卡片>`，超過 64 bytes 就只送文字，因為截短的卡片名會答到別的工作。
- **失敗**：一輪的 input 在 Pi Durable 裡結束成 `unanswered`（`model_error`、`no_model`、`aborted`、`faulted` 或孤兒化的原因，見 durable spec 8.3）時，HumanPort 發 `failure` 事件，帶 `requestId` 和人看得懂的原因，`model_error` 附上供應商的錯誤文字。介面卡把自己那一輪的失敗當回答送回；`schedule:` 和 `agent:` 開頭（`src/ports/human.ts` 的 `PUSHED_FAILURES`）是核心自己發起的輪次，沒有人在等，所以每個介面卡都把它們的失敗當通知推給人。`digest:` 那一輪的失敗不推，因為彙報任務已經把失敗原因和原始工作清單寫成通知。終端機的 7501 根紀錄在失敗後報 `error`，直到人再輸入。事件快照不含 submission，所以重啟後不會再發一次已經發過的失敗。
- **進度**：工具結果的 `details` 帶 `forwarded: true`（`src/core/notice.ts` 的 `FORWARDED`，目前只有 `reply`）時，HumanPort 對這一輪每個已放進來的 input 發一次 `notice`，`kind` 是 `forwarded`，帶 `requestId`、不帶內容。它只是事件，不寫成紀錄，因為進度不必撐過重啟：重啟前已放進來的 input 不會再收到 submission 事件，它的 `forwarded` 會遺失。2026-10-23 決定先放進 `notice`，之後再評估要不要拆成獨立事件。Telegram 用 `setMessageReaction` 把進度標在人的訊息上：收下是 👀、`forwarded` 是 👌、回答是 👍、失敗是 👎。非 premium 的 bot 每則訊息只能有一個反應，所以後一個蓋掉前一個；對應表在 `src/adapters/telegram/index.ts` 的 `REACTIONS`。反應失敗只記錯誤，不擋輪詢。
- **Telegram 只認一個聊天室。** bot token 和聊天室 id 都設了才啟動（見「設定」），其他聊天室的訊息和按鈕一律丟掉，因為找到這個 bot 的任何人都能派 agent 在這台機器上跑。訊息 id 只在同一聊天室內唯一，所以只認一個聊天室也讓 `telegram:<message id>` 不會撞號。介面卡以 `telegram:` 前綴認自己的輪次，不記送過哪些 id，所以核心在重啟後才答完的那一輪仍會送回手機。

客戶端 socket 的現況：

- **Pi Durable 沒有任何伺服器、傳輸層或 RPC。** `durable/src` 裡沒有任何伺服器程式碼；規格只說「Transport backpressure and disconnect policy belong to the consumer」（spec:4773）。
- **Chord 有相關的積木。** 伺服端 `acceptWebSockets`（`chord/src/websocket.ts:18`）要自備 ws server 和一個 principal 驗證器（`websocket.ts:5, 14`）；客戶端 `webSocketLink` 在 `chord/src/link.ts:414`，狀態變更用 `@earendil-works/chord/delta` 套用。
- **遠端送訊息要自己寫。** 需要一個包住 `Conversation.submit` 的方法。

### agent 側（核心 → agent 介面卡）

每種 agent 介面卡實作同一組動作：

| 動作 | herdr 的實作（出處皆為 cc-mobile commit d9f0690） |
|---|---|
| 開始 | `workspace.create` → 等 shell 就緒 → `agent.start{name,kind,pane_id,args}`，args 帶 `--session-id` → 輪詢 `agent.get` 直到 `interactive_ready`（`server/herdr/registry.ts:140-215`） |
| 送出提示 | 確認狀態是 idle 或 done 且輸入框為空（`send-routing.ts:62`） → `pane.send_text` → `pane.send_keys Enter` → 可選的確認啟動，沒動就補按 Enter（`server/herdr/send-routing.ts:207-266`，只有 `/api/launch` 打開這個選項） |
| 狀態事件 | 原生狀態有 idle、working、blocked、done、unknown；前四種對應成 idle、running、requires_action，unknown 直接丟棄（`server/herdr/agent-state.ts:20-30`）。soma 內部改用 OSC 7501 的詞彙，見下節 |
| 讀結果 | 讀對話紀錄（見上一節） |
| 回應卡住 | `pane.read source:detection` 解析提示（`native-permission.ts:172`） → 比對指紋 → 送出前再讀一次畫面比對 → `pane.send_keys`（`server/herdr/permission/native-permission.ts:334-440`）。soma 在 blocked 時讀畫面補上 `kind` 和指紋，指紋隨叫醒模型的 input 交給模型，模型回答時帶回來比對 |
| 停止 | `workspace.close`（`server/herdr/backend.ts:477`、`registry.ts:252`）。soma 的 herdr 介面卡還沒實作（`src/adapters/herdr/agent-port.ts:185`） |

soma 和 cc-mobile 都把工作派進同一個 herdr 機庫 session。機庫名稱來自 `ecosystem.config.cjs:48` 的環境變數，目前是 `fleet`，程式裡沒有預設值（`server/config.ts:131-138`）。並發上限的算法是效能核心數減 2、最少 1，讀不到核心數時預設 4，可用 `CC_MOBILE_HANGAR_CAP` 覆寫（`server/hangar-cap.ts:1, 52`）。cc-mobile 的佔用數取自機庫裡實際在跑的 agent 數（`server/sided-backend.ts:168-171`），所以 soma 直接派進機庫的 agent 也會被它算到；反過來 soma 若自己派工，也要用同樣的算法。

herdr 的連線方式不是 JSON-RPC 2.0。每次呼叫開一條新的 unix socket 連線，送出 `{id,method,params}` 加換行；目前釘住的協定版本是 22（`server/herdr/transport.ts`、`client.ts:64`；herdr 0.9.5 的 `src/protocol/wire.rs:20` 也是 22）。

### rex 的實作（2026-10-24 實測）

rex 是終端多工器，也是終端機本身。查證時的版本是 rex `0.0.1792787366-g623b2d`（API revision 7）和 Claude Code 2.1.310。API 文件在 server 的 `GET /llms.txt`，每個方法的 JSON Schema 在 `GET /api/help`。2026-10-24 另有一份獨立審查重查過本節，標「未複驗」的是只有一次實測、審查沒有重跑的。

rex 沒有 herdr 替 soma 擋下的四件事：轉換計數器（`state_change_seq`）、同名拒絕（`agent_name_taken`）、建立 worktree、信任對話框回報 `blocked`。rex 介面卡和核心要自己補上，做法寫在下面各點。

- **連線。** server 在 unix socket `~/Library/Application Support/rex/server.sock` 上說 HTTP。控制連線是 `GET /api/control` 的 WebSocket，subprotocol 是 `rex.control.v1`，先送 `hello` 帶 `api_revision`，之後是 `{type:"request",id,method,payload}`。server 支援 revision 0 到 7 並向下協商，不像 herdr 要求協定號完全相等。
- **狀態。** Claude Code 在 rex 裡自己送 OSC 7501，狀態回報不需要任何 integration。`rex skill setup` 另外會在 `~/.claude/settings.json` 裝一個 SessionStart hook，只告訴 agent 它在哪個 session 和 block，和狀態無關。block 方法 `program_status` 回傳記錄，帶 `state`、`kind`、`msg`、`app=claude-code`、`owner` 和 `updated_at`。實測依序看到 `idle`、`working`、`blocked`（`kind=question`，`msg` 是「answer: <問題> (<選項> · <選項>)」）、`blocked`（`kind=permission`，`msg` 是「approve Bash: touch probe.txt」）、`done`（未複驗）。
- **只看根記錄。** subagent 會在同一個 block 留下帶 `id` 和 `title` 的子記錄。實測 subagent 要權限時，根記錄變成 `blocked`，子記錄一直是 `working`（未複驗），所以 agent 狀態取沒有 `id` 的那筆。
- **辨識 claude 看 `argv0`。** 記錄的 `owner.name` 和 `process` 方法的 `foreground.name` 都是 `2.1.310`，因為執行檔在 `~/.local/share/claude/versions/2.1.310`；`foreground.argv0` 才是 `claude`。pid 也從 `process` 取，這樣沒有 7501 記錄時（例如信任對話框）也查得到。
- **信任對話框沒有任何訊號。** On 2026-10-24 the first-visit folder-trust dialog was on screen while `records` was empty. herdr reports `blocked` on the same screen and the event bridge wakes the model to answer it (see the point about the first prompt of a dispatch in「事件橋」); under rex there is no record and no event, so the agent would sit on the dialog and soma would never know. Re-checked on 2026-10-26 with Claude Code 2.1.310 and rex `0.0.1792787366-g623b2d` (API revision 7), each time starting `claude` from an interactive shell in a rex block:
  - `<soma checkout>/.claude/worktrees/<name>`, a linked worktree of a repo the human has trusted: no dialog, and `program_status` already held one root record with `state=idle`. claude wrote no project entry for the worktree path, so the trust it used came from the main checkout.
  - `<fresh repo>/.claude/worktrees/<name>`, a linked worktree of a fresh, untrusted repo under `~/.cache`: dialog shown, `records` empty.
  - A linked worktree of the same fresh repo, placed outside the repo: dialog shown, `records` empty. This matches what herdr's smoke run saw that day in `~/.herdr/worktrees/…`.
  - A fresh `mktemp -d` directory under `$TMPDIR`: no dialog, and claude wrote `hasTrustDialogAccepted: true` for it without asking. That control was invalid, because claude seems to trust `$TMPDIR` on its own.

  So `.claude/worktrees/` does not exempt a folder from the dialog. The worktree inherits trust from its main checkout, and claude asks wherever the repo itself is untrusted. The worktree still goes at `.claude/worktrees/<card>` (see the next point); that is enough for repos the human has already trusted. For any other repo, the adapter must catch the dialog itself: when the foreground is claude and no record has arrived for a few seconds, it reads the screen and, if it finds the trust dialog, emits `blocked:kind=permission`. This check is part of the plan, not an optional backup.

  As built (M5-2, `src/adapters/rex/agent-port.ts`, `observe` and `trustDialog`). While a block of the hangar has claude in the foreground (`process` → `foreground.argv0`) and no root record has been seen for it, the watch looks at the block every 3 s. Once claude has been running for 3 s it reads the screen (`com.superlogical.terminal.format`, the last 64 KiB) and parses it with the shared `readBlockedScreen`; a permission prompt offering "…trust this folder" (`isTrustDialog`, which matches both the 2.1.302 and the older numbered fixture) is emitted as `blocked` with `kind: "permission"` and the parsed `msg`, `fingerprint` and options. The `msg` gets one more line, naming what answering yes trusts: the repository root, the main checkout of the worktree claude runs in (first in `git worktree list --porcelain`, run in the block's cwd; the cwd itself when git cannot name one; either answer is kept per cwd, so a git that fails once and then recovers cannot change the msg, which the core would take for a new prompt), since claude records the trust for that root, and with it every worktree of the repo, not for the worktree path the dialog shows (M5-2b). `list()` reports the same status, so a restart sees it too. The first root record ends the check for that block; it is marked the moment its event arrives, so a screen read already in flight reports nothing past it, and it is emitted even when rex stamped it below the adapter's last dialog seq.
  The seq of the first report is the time the condition first held, claude's start plus 3 s, in microseconds. rex reports no start time, so the adapter reads it off `ps -o lstart=` for the foreground pid (`process-start.ts`, to the second). `ps` runs with `TZ=UTC` and its text is parsed as UTC, so the instant is the same whatever TZ soma runs under; before M5-2b `ps` printed the system zone and soma read it in its own, and a TZ ahead of the system's put claude's start hours in the future, which turned the check off. Every soma process therefore names the same dialog alike: a core killed after waking the model, before it committed the seq, sees the block again under the same seq after a restart, and its `agent:<agent>:<seq>` requestId makes the submit a no-op. The current time would have woken the model a second time. A dialog seen again within one process goes under the current time, above the block's last seq, and the core dedups it by fingerprint (`Job.handedOver`); that re-report is what hands the dialog over if the first report found no job yet. Accepted edge: if the first report found no job and a later one woke the model, a restart reports the first seq again and wakes the model once more for the same dialog; `respond` still checks the fingerprint against the screen.
  Checked on 2026-10-27 with `node smoke/rex-bridge.ts` (a fresh repo under `~/.cache`, rex `0.0.1792787366-g623b2d`): the dialog was reported 3 to 6 s after claude started (the check runs every 3 s), the woken requestId was claude's start plus 3 s, a reopened core resubmitted it as a no-op with no model call, and re-reports every 3 s woke nobody. Answering "Yes, I trust this folder" through `respond` wrote `hasTrustDialogAccepted` into `~/.claude.json` for the repo root, not for the `.claude/worktrees/<card>` path claude ran in, which agrees with the worktree inheriting trust from its main checkout. That is why the dialog's status names the repository root (above); the smoke checks the wake's last line names the smoke's repo and that the trust entry it gained is that repo's.
- **worktree 由介面卡自己建。** rex 沒有 worktree 相關的方法。介面卡用 `git worktree add` 建在上一點的位置，分支照舊是 `fleet/<card>`；重跑時分支已存在就開回同一個 worktree，對應 herdr 的 `worktree.open`。cc-mobile 的 `server/launch-worktree.ts` 有現成邏輯可以參考。
- **同名不會被拒絕。** 審查實測用同一個 label 建兩個 session，兩個都成功；window 和 block 的 label 也沒有唯一性。所以派工冪等只剩 soma 自己的 list-before-start。機庫 session 要用設定檔裡的 `session_id` 找，不用 label；`list()` 看到同名的多筆時要報錯，不能取第一筆。
- **選項仍要讀畫面。** `msg` 只有問題和選項的文字，沒有選項編號，所以回應卡住照舊要讀畫面（`com.superlogical.terminal.format`）解析選項和指紋。As built (M5-2, `respond`): it re-reads the root record, which must be `blocked`, or, with no record, the screen must show the trust dialog; otherwise it refuses `not_blocked`. It then reads the screen's last 64 KiB (`format` with `max_bytes`, the rest through `blob_read`, since the whole scrollback can outgrow one reply) and refuses as herdr's adapter does: `auth`, `unreadable`, `stale`, `unknown_option`. The keys `answerKeys` returns go to the block as `block.event` events of type `key`, whose payload is `client.key`'s key object (the API reference leaves it out; checked against the server on 2026-10-27). Each key is a press and a release, as `rex send-key` sends them, with 200 ms between keys so claude reads an arrow and the Enter after it as two keys. A key `answerKeys` names that rex cannot spell, such as a two-digit option, sends nothing and refuses `unreadable`.
  A blocked root record carries no options and no fingerprint, so the status the adapter reports for it is read off the screen the same way (M5-2b, `statusOf`), on the event path and in `list()` alike, as herdr's `blockedState` does: when `readBlockedScreen` finds a prompt, the status takes its `kind`, `msg`, `fingerprint` and options, and the core's wake can offer `respond` with that fingerprint; when the screen does not parse or cannot be read, the record's own status goes out without a fingerprint, a block only `escalate` can hand on. claude can report the block before it has finished drawing the prompt, so a screen that does not parse is read again, up to 3 reads 500 ms apart, as herdr's `blockedState` does (M5-2c). Every report of a blocked record reads the screen again, a re-stamp, a resync and `list()` included: M5-2c kept the status that parsed per block under the record's `state`, `kind` and `msg`, and M5-2d removed it, since a second prompt whose record reads the same, with no other status between, kept the first prompt's fingerprint, so `respond` refused it as stale and the core never woke the model for it. The redraw retry already covers a prompt read half drawn.
- **session 識別。** 記錄裡沒有 herdr 的 `agent_session`。Claude Code 會寫 `~/.claude/sessions/<pid>.json`，裡面有 `sessionId`、`cwd` 和 `status`，pid 和 `owner.pid` 對得上。派出去的 agent 本來就帶 `--session-id`，所以讀對話紀錄不需要這個檔；它的用處是偵測 `/clear`，實測 `/clear` 之後同一個 pid 的 `sessionId` 會換成新的（未複驗）。這是 Claude Code 沒有文件的內部檔案，讀取時要驗證格式，格式不符就當作讀不到。
- **沒有轉換計數器，改核心的判斷而不是在介面卡合成一個。** rex 每收到一次回報就發一次 `program_status_changed`，即使只有 `updated_at` 變了（API 文件 `program_status_changed` 的說明）。Before 2026-10-26 the core's `observe` treated "same state, new seq" as "the agent went somewhere and came back", so with `updated_at` as the seq, a re-reported `blocked` or `idle` would have woken the model again or recorded another turn. 介面卡也沒有地方存一個能撐過 soma 重啟的計數器。所以改的是核心：seq 的語意改成「同一個值就是同一次觀察」，不再保證新值代表有轉換；`blocked` 只在指紋或 `msg` 變了才再叫醒；完成以 transcript 最後一則 assistant 訊息的 id 去重 (since M5-2d, by the `uuid` of the transcript's last record, whoever wrote it; see「事件橋」)。herdr 和 rex 餵這套規則都正確。Measured on 2026-10-27 (rex 0.0.1792787366-g623b2d, Claude Code 2.1.311, `rex events -s <session> --json` on a throwaway session, claude started with `--permission-mode default` in this checkout, raw events counted before any adapter): a Bash permission prompt left on screen for 60 s brought one `blocked` record when it appeared and no `program_status_changed` after it; answered with Escape, the block sent `working` then `idle` within 70 ms, and claude left idle for the next 60 s sent none. So in that run rex did not re-report a resting `blocked` or `idle`; the core's dedup by seq, fingerprint and last record stays the guard for the re-reports the API reference allows.The core change is done (2026-10-26). As built, `blocked` compares against the last prompt handed over rather than the stored status; the full rule is in「事件橋」.
- **事件串流，不輪詢。** 同一條連線內的事件 `seq` 從 1 起逐一遞增、沒有空號；斷線期間的事件會遺失，新連線的 `seq` 從 1 重新開始（API 文件「Reconnecting」一節）。所以介面卡只靠事件，重連後對每個 block 重讀一次 `program_status`，不照抄 herdr 介面卡 `status-watch.ts` 的每秒輪詢。
- **機庫是一個 rex session。** 派出去的 agent 各是 `fleet` session 裡的一個 window，Rex.app 的 session 清單只多一筆，不會和人自己的 session 混在一起。機庫上限以這個 session 裡前景是 claude 的 block 數計算。同機也能用 `rex server run --listen unix://<路徑> --state-dir <目錄>` 跑第二個 server，但機庫只要求分隔、不要求故障隔離，所以不採用。
- **claude 退出時 block 預設會關閉。** terminal flavor 的 `exit.on_completion` 預設是 true，claude 一退出 block 就從清單消失，對帳會把還沒結束的工作記成 agent 不見了。做法是開一個互動 shell 的 block，用 `initial_input` 打 `claude --session-id …` 的啟動指令，claude 退出後回到 shell，和 herdr 的 pane 一樣。`initial_input` 不能拿來送第一則提示，因為它會在 agent 就緒前就打字。建立時沒有 env 參數，環境變數寫在啟動指令裡。關閉用 `block.close`。
- **送出提示要確認有動。** 實測 claude 剛啟動時，`rex send` 之後的 `rex send-key Enter` 沒有送出，改用 `write` 送 `\r` 才送出（未複驗）。soma 的 herdr 介面卡送提示時沒有確認步驟（`src/adapters/herdr/agent-port.ts:131-135`），rex 介面卡要加：送出後狀態沒有變成 `working`，就補送一次 `\r`。As built (`prompt`): before anything is typed, the root record is read again, and only `idle` or `done` lets the prompt through; any other state, or no record (such as the trust dialog), throws an `Error` naming the agent and the state, with nothing written, since the `\r` would choose the highlighted option of a prompt on screen. M5-1 sent that first `\r` unconditionally. Then the prompt is a `paste` block event and `write` sends `\r`; a second `\r` follows only when no `working` record arrives within 3 s and a fresh read still says `idle`. The bridge's launch goes through the same check, so a launch prompt held while the agent sat on the trust dialog goes out at the first `idle` record after the dialog was answered (`node smoke/rex-bridge.ts`, 2026-10-27).
- **claude reports a turn over before it writes the turn.** Checked on 2026-10-27: rex passed claude's `done` on at once, and the transcript then held none of the turn's records, the prompt's own included, although they are stamped up to about 50 ms before the report; claude writes them in batches afterwards. Read at the `done`, the first turn of a session had no reply, and the bridge recorded it with outcome 未知 and no reply id. herdr's polling reads late enough to hide this. So `readResult` waits, for up to 2 s (`replyMs`), until the transcript was modified at or after the time the watch saw the block's last turn end and its last conversation record is neither the user's nor an assistant record holding only thinking (`awaitingReply` in `src/agent-cli/transcript.ts`), and then reads what it ends on (`readLastRecord`). When 2 s pass first it reads what the transcript then ends on (`readLastRecord`), and returns `undefined` only when there is no transcript or no record with an id in it, as `src/ports/agent.ts` says. A turn that ended on the user, interrupted or ended by a denied permission, never gets a reply, so it is named by its last record, without text, and recorded 未知 once; it costs the full 2 s at that first read. A turn claude wrote shortly before rex stamped its end, so the file's modification time is earlier than the end, is read whole at the timeout and recorded once with its outcome. A turn not written at all by then reads as the turn before's last record, which the core already holds, so nothing is recorded at its end. Every read the timeout ends schedules a re-check of the block 10 s later (`recheckMs`), which reports the block's done, idle or error again unless the watch saw it go on to work or a prompt, so a turn written since is read then (accepted edge (a) and the slow-flush cases in「事件橋」, M5-2f). M5-2d returned `undefined` when the transcript had not been modified since the turn ended, so a turn written just before its end was stamped recorded 未知 first and its real outcome, or a second 未知, at the next re-stamp; M5-2e returns the last record, and M5-2f added the re-check. M5-2b returned `undefined` at every timeout, and before M5-2b it read what was there at once.
  The time a turn ended is the watch's, kept per block (`track`): the seq of the `done`, `idle` or `error` it reports after a `working`, with any `blocked` in between. A `done`, `idle` or `error` reported with no `working` seen since clears it (M5-2d), so "unknown" means unknown and the read does not wait against the turn before's end: a re-stamp of an end, a resync after a reconnect gap that spanned the turn's start, so it reads the new `done` while no `working` was seen, a `working` dropped because its seq is below one already reported, an event skipped because `process` read a transient non-claude foreground, or one whose payload failed its schema. Without an end the transcript is read at once, so a re-stamp reads the last record the core already holds and records nothing, without waiting, whether the turn ended on a reply or on the user. M5-2c kept the end on such reports: a turn that ended on the user waited out the 2 s at every re-stamp and recorded a phantom 未知 turn each time, and a turn read across a gap came back at once as the turn before's reply. One gap case is recovered rather than unknown: a resync that reads a turn's `done` while that turn's `working` event is still queued behind it, which the watch then drops as older than what it reported; that `working`, newer than the report before the `done`, still marks the `done` as the end of a turn (or, when the resync read `working` or `blocked`, the turn as on), and `readResult` takes the end only after the watch's work queued when it asks, which its own calls to rex follow on the client's one connection, so that `working` has been tracked. Work queued after that is not waited for, but the read does wait for the backlog queued before it asks, which a block re-reported faster than its unparsed screen is read three times can grow without bound (a known limit, left open: the M5-3 measurement saw no re-report of a resting `blocked` or `idle` in 60 s each, see「沒有轉換計數器」above, so the backlog needs a block re-reported many times a second, which no run has shown); the first M5-2e build waited until the queue was empty, which another block re-reported faster than its screen was read could postpone without end. M5-2d took the end after its first call to rex, which a slow resync of another block could beat, and then read the turn before's reply at once. A resync's report goes through the same rule as an event's and does not clear the end on its own: a `working` seen before a short gap still tells that the `done` the resync reads ends its turn, and discarding it would read that turn at once, before claude wrote it. The loss when the watch cannot tell, and the transcript does not hold the turn yet: the read returns the turn before's last record, which the core takes for a turn already recorded, so the turn is recorded only at a later re-stamp read once claude wrote it, or not until the next turn. At the startup reconcile, which runs before the watch, that is a turn that ended within about 50 ms of a restart. The wait sleeps no longer than is left of the 2 s; before it, the read waits for the watch's work already queued, bounded by that backlog. Both run inside the bridge's queue, which a slow read holds up for every agent; the 2 s bound was accepted.
- **As built (M5-1, `src/adapters/rex/`).** One control connection per adapter (`client.ts`), over a WebSocket written on `node:http` (`websocket.ts`), since the adapter takes no dependency beyond node built-ins and zod; it is attached to the hangar session, re-attached after a reconnect, and only keeps the process alive while a request waits. A status's seq is the root record's `updated_at` in microseconds since the epoch (`seqOf`). `onStatus` emits a block's reports in seq order: one at or below the last seq it emitted for that block is dropped, so an event that queued behind a reconnect's re-read never overtakes the newer record the re-read found. Each agent is a window labelled with its name, holding one shell block whose own label is claude's session id: rex records nothing else that `readResult` and `list` could read the session id from, and the block label survives a soma restart. The prompt is sent as a `paste` block event, so a multi-line prompt stays one message, then `write` sends `\r`; a second `\r` follows when no `working` record arrives within 3 s and a fresh read of the root record still says `idle`; on `blocked`, `working`, `done` or an unreadable record it is not sent, since `\r` on a prompt would answer it. Checked against the real server on 2026-10-27 (`node smoke/rex-dispatch.ts`): claude in a trusted repo's `.claude/worktrees/<card>` showed its first root record (`idle`) about 1 s after the block opened, and a prompt turned it `working` after one `\r`. Stubbed in this slice: `respond` refuses with `unreadable`, there is no folder-trust dialog check, and `start` resolves the cap from `hangar-cap.ts` but counts no rex blocks against it. M5-2 replaced the first two (see the trust-dialog point and「選項仍要讀畫面」above), and M5-3 the third: `start` counts the blocks of the hangar session, on every window and layer, whose `process` foreground is `claude`, and refuses with `hangar is full` when they reach the cap, before any worktree or window is made.
- **omp 不送 7501。** `~/workspace/oh-my-pi` 的原始碼裡沒有 OSC 7501，在 rex 裡 omp 的 pane 沒有狀態記錄。要到 omp repo 協助導入，優先順序低。
- **成熟度。** rex 的 build 日期是 2026-10-23，Mac app 在封閉測試，Program Status 規格是 revision 0.4（2026-10-10）。Rex for iOS 已經存在但還不在公開測試；推播到手機寫在規格的「未來計畫」裡，目前沒有。

### agent 側介面卡的能力差異

兩端的介面卡都是可選的，使用者依自己的習慣在設定裡選，功能差異由使用者自己取捨。核心不假設任何一項能力一定存在：缺了某項能力時，核心照下表的「沒有時」一欄降級，不報錯。

| 能力 | rex | herdr | 原生 tty（M6） | 沒有時 |
|---|---|---|---|---|
| soma 重啟後 agent 還在 | 是，由 rex server 託管 | 是，由 herdr daemon 託管 | 否，pty 隨 soma 結束 | 重啟後的對帳把還沒結束的工作記成 agent 不見了，通知人一次 |
| 人能直接看畫面、親手接手 | Rex 的客戶端 | herdr attach | 否 | 只能經人類側介面卡回答提示 |
| 狀態來源 | agent 自己送的 7501，經 rex 的 API | herdr 自己的偵測 | agent 自己送的 7501，由 soma 回應探測並解析 | agent 不送 7501 時沒有狀態，例如今天的 omp |
| 讀畫面回答提示 | `com.superlogical.terminal.format` | `pane.read` | soma 自己的終端模擬器，`@xterm/headless` | 只能等人親手回答 |
| 建 worktree | 介面卡自己跑 git | herdr 的 `worktree.create` | 介面卡自己跑 git | 不適用，三者都有 |
| 同名拒絕 | 沒有，靠 list-before-start | 有 | soma 自己的 pty 表，同一程序內擋得住 | 只靠 list-before-start |

人類側也一樣：Telegram 能推播和用按鈕回答提示，終端機只在前景時看得到，shikigami 之後補上。

維護分優先級。maintainer 積極維護自己在用的介面卡，目前是 rex、Telegram 和終端機；其他介面卡在核心改動時會跟著過測試，但 agent 端或平台升版造成的問題不保證修。

### agent 狀態模型：採用 OSC 7501 的詞彙

[OSC 7501（Program Status Protocol）](https://www.superlogical.com/rex/docs/build/program-status)是一個終端機跳脫序列，讓程式自己回報 `idle`、`working`、`blocked`（`kind` 為 `permission`、`question`、`auth`）、`done`、`error`，可帶 base64 的 `msg`，並能用 `id` 回報多筆階層式紀錄。背景見 [Mitchell Hashimoto 的文章](https://mitchellh.com/writing/program-status-osc7501)。

soma 要支援它，分成兩邊：

- **內部狀態模型直接用 7501 的詞彙。** herdr 的 idle／working／blocked／done 對應過來，`blocked` 的 `kind` 由權限解析補上，cc-mobile 的 idle／running／requires_action 不再沿用。這樣 herdr 對應和未來的 7501 來源餵進同一個形狀，事件橋的「`kind=auth` 一律轉人」規則也直接寫在 `kind` 上。
- **發送：soma 的終端機客戶端回報自己的狀態。** 根紀錄是 soma 本身（有一輪在跑是 `working`，助理要問人是 `blocked:kind=question`，報告寫好是 `done`），每件派出去的工作一筆子紀錄 `id=job/<task>`。Pi 的 emitter 可以直接沿用（`tui/src/program-status.ts`，53 行，只支援根紀錄，要補 `id` 和 `title`），Pi 自己的狀態對應表在 `coding-agent/docs/terminal-setup.md:221-233`。這是 M1 的一部分，成本約一打行。
- **接收：pty 是 herdr 的，soma 不自己讀。** 7501 要到 soma，得等 herdr 把它當成狀態來源。herdr 0.9.5 的文件和 release notes 都沒提 7501；對應的提案 [herdrdev/herdr#5069](https://github.com/herdrdev/herdr/issues/5069) 於 2026-10-08 被關掉並導向 discussions。Claude Code 2.1.295 起會送 7501，但只在終端機先回應探測時才送（[anthropics/claude-code#103022](https://github.com/anthropics/claude-code/issues/103022) 在要求一個不用探測的開關）。因此「在 herdr 裡的 Claude Code 目前不會送 7501」是推論，未實測。如果之後 soma 自己用 pty 跑 agent（ACP 路線），就要在那一層回應探測並解析 7501。這就是 M6 原生 tty 介面卡要做的事。走 rex 介面卡時，pty 是 rex 的，rex 會回應探測，Claude Code 的 7501 經 rex 的 API 交給 soma（見「rex 的實作」）。

ACP 是第二種 agent 介面，等有具體需求才做。依據 [agentclientprotocol.com](https://agentclientprotocol.com) 的文件：

- **stdio 是唯一的穩定連線方式**，由客戶端把 agent 當子程序啟動。客戶端死掉時 agent 會怎樣，規格沒寫。
- **斷線後能否接回要看 agent 有沒有實作。** `session/load` 和 `session/resume` 都是選配功能。
- **權限請求是結構化的**（`session/request_permission`），比 herdr 解析螢幕畫面乾淨。
- **穩定版沒有 blocked 狀態**，要到 v2 草案的 `requires_action` 才有。
- **Claude 要透過介面卡** `@agentclientprotocol/claude-agent-acp`（0.93.0），它包的是 Claude Agent SDK，不是 Claude Code CLI 本體（[agents 清單](https://agentclientprotocol.com/get-started/agents)）；Gemini CLI 以 `--acp` 原生支援。SDK 是 `@agentclientprotocol/sdk` 1.9.0。

結論：沒有唯一的主力，由使用者選。由終端託管 agent 的介面（rex、herdr）讓核心重啟時 agent 仍在，人也能隨時切進 pane 親手接手；原生 tty 少了這兩項，但不必另裝多工器。ACP 適合核心自己開、跑完就收的短工作。

## 可以沿用的現有程式碼

cc-mobile `server/` 裡有 2,971 行（含註解與空行）只在清單內互相匯入，外部依賴只有 zod 和 node 內建模組。這些模組有注入縫，但預設實作會直接讀寫檔案和 socket，不算純函式：

- **herdr**（`server/herdr/`）：`transport.ts`、`client.ts`、`subscribe.ts`、`schema.ts`、`errors.ts`、`sides.ts`、`agent-state.ts`、`readiness.ts`、`prompt-box.ts`。
- **權限解析**（`server/herdr/permission/`）：`prompt-parse.ts`、`claude-question.ts`、`omp-prompt.ts`。
- **對話紀錄**（`server/transcript/`）：`path.ts`、`reader.ts`、`records.ts`、`epoch.ts`。以上 16 檔共 2,679 行。
- **派工**（`server/` 根目錄）：`hangar-cap.ts`、`launch-queue.ts`、`launch-binding.ts`，共 292 行。

這些檔案用到三個 Bun 專屬 API，改用 Node 時都要換：`transport.ts:47` 的 `Bun.connect`（經注入縫傳入）、`reader.ts:53, 62` 的 `Bun.file`、`hangar-cap.ts:52` 的 `Bun.spawnSync`。沒有用到 `bun:sqlite` 或 `Bun.serve`。

`pane-events.ts`、`delivery.ts`、`native-permission.ts` 把結果直接寫成手機協定的訊息格式，抽出來時要改成一般回呼。`launch.ts`、`ws.ts`、`protocol.ts` 和 cc-mobile 緊密耦合，不沿用。

## 外部依賴

- **Pi 套件。** `@earendil-works/pi-durable`、`pi-ai`、`chord`、`pi-mcp` 目前都是 1.3.0，要求 Node >=22.19.0。pi-durable README 第 3 行寫明「Experimental. The API changes without notice between releases.」，版本要釘死。
- **Bun 沒有現成的儲存介面卡。** README:688 說核心可以在 Bun 上跑，但要自備 `SqliteDatabase` facade。這個抽象層定義在 chord（`chord/src/sqlite/database.ts:2-38`），共六個非同步方法：`exec`、`run`、`get`、`all`、`transaction`、`close`。Node 版 `chord/src/sqlite/node.ts` 有 201 行，`bun:sqlite` 版的行數未驗證。conformance suite 是 `registerStorageConformance`，從 `@earendil-works/pi-durable/testing` 匯出，但它只測儲存層，不測整個 harness 在 Bun 上跑。
- **模型供應商。** pi-ai 支援 Anthropic API key，也支援 Claude Pro/Max 訂閱的 OAuth（`ai/src/providers/anthropic.ts:19-90`）。走 OAuth 時它會偽裝成 Claude Code：送出 `user-agent: claude-cli/...` 和 `x-app: cli`（`ai/src/api/anthropic-messages.ts:1059-1062`）、加上 Claude Code 的 beta 標頭（`:1142`）、注入「You are Claude Code」系統提示（`:1227-1232`），原始碼自己稱之為「Stealth mode」（`:95`）。Anthropic 的官方立場是不允許的：[Claude Code 法律合規頁](https://code.claude.com/docs/en/legal-and-compliance)寫明訂閱 OAuth「is designed to support ordinary use of Claude Code and other native Anthropic applications」，且「Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, or Max plan credentials」；[Consumer Terms](https://www.anthropic.com/legal/consumer-terms) 禁止以 API key 以外、未經明示許可的自動化方式存取服務。所以 soma 預設用 API key。
- **MCP。** `@earendil-works/pi-mcp` 是獨立的客戶端，支援 stdio、Streamable HTTP 和 OAuth。接到 pi-durable 的轉接層是 `src/core/extensions/mcp/index.ts`，目前只接 stdio server。shikigami-bridge 的瀏覽器與 macOS 控制就經由這條路接進來。轉接層現在把 server 列出的每個工具都直接提供給模型（`src/core/extensions/mcp/index.ts:35-56`）。目前 workspace-mcp 只開 Gmail 與 Calendar 的讀取類工具（待決事項 5），工具數量和 token 成本都還沒量測。之後接上 shikigami-bridge 的瀏覽器與 macOS 控制、工具數變多時，要改轉接層：`defineTool` 加 `deferred: true`，並安裝 `createToolSearchExtension()`（從 `@earendil-works/pi-durable/tool-search` 匯出）。pi-durable 建議大型工具集這樣做，例子就是 MCP server 的工具（`node_modules/@earendil-works/pi-durable/README.md:253`）。代價是同一條分支第一次用到某個工具前，模型要先搜尋；載入後的工具會一直保留，壓縮後也是（同一行）。例如「今天有什麼會」第一次會多繞一次，所以改完驗收要用真模型。

## 設定

soma 啟動時讀一次設定檔：環境變數 `SOMA_CONFIG` 指定的檔案，沒設時是 `~/.config/soma/config.json`（`src/config.ts` 的 `configPath`）。沒設時讀的是 prod 的設定，所以 dev 實例要設 `SOMA_CONFIG` 指向自己的設定檔，用不同的 `db`、不設 `telegram`（見里程碑「常駐服務」）。每個值先看環境變數，再看設定檔，最後用預設值；欄位、對應的環境變數和預設值都在 `src/config.ts` 的 `resolveConfig`。檔案不存在就只用環境變數和預設值。JSON 壞掉、欄位型別不對或有不認得的欄位時，soma 印出檔案路徑和欄位名稱後以狀態 1 結束，不帶著部分設定跑。範例：

```json
{
  "agentAdapter": "herdr",
  "herdrSocket": "/Users/me/.config/herdr/sessions/fleet/herdr.sock",
  "rex": { "sessionId": "session:01a1...", "socket": "/Users/me/Library/Application Support/rex/server.sock" },
  "mcpConfig": "/Users/me/.config/soma/mcp.json",
  "db": "/Users/me/.local/share/soma/soma.sqlite",
  "model": "claude-opus-5-5",
  "language": "zh-Hant-TW",
  "hangarCap": 4,
  "programStatus": true,
  "repo": "/Users/me/workspace/soma",
  "reflection": true,
  "anthropic": { "apiKey": "sk-ant-..." },
  "exa": { "apiKey": "..." },
  "telegram": { "botToken": "123456:ABC...", "chatId": 123456789 }
}
```

- **`agentAdapter`, `herdrSocket` and `rex`.** `agentAdapter` (`SOMA_AGENT_ADAPTER`) picks the agent-side adapter, `"herdr"` or `"rex"`; unset, it is herdr, so a config written before rex keeps working, and `src/main.ts`'s `openAgentPort` is the one place that builds it. herdr reads `herdrSocket` (`SOMA_HERDR_SOCKET`). The `rex` settings are read and checked only when rex is selected: `rex.sessionId` (`SOMA_REX_SESSION_ID`) is the hangar session's id, such as `session:<uuid>`, and is required, because the adapter finds the hangar by id, never by label (see「rex 的實作」); `rex.socket` (`SOMA_REX_SOCKET`) is the rex server's socket, by default `~/Library/Application Support/rex/server.sock`. `hangarCap` applies to either adapter; rex counts the hangar session's blocks running claude against it (see「rex 的實作」).
- **`repo` and `reflection`.** `repo` is soma's own git checkout, where the reflection reads `.obsidian.yaml` and sends its code-change cards; unset, it is the directory the code runs from, which prod must override once it runs from a release. `reflection: false` leaves out the daily reflection and its `open_card` tool, which dev sets so a dev db does not open cards. A reflection task a db already holds stays `pending` while it is off and the same task resumes when it is turned back on, without a second one being created (checked 2026-10-26 on a copy of a dev db).
- **路徑不展開 `~`。** 請寫絕對路徑；`db` 寫相對路徑時以啟動時的目錄為準。
- **模型 key 不寫進 `process.env`。** `anthropic.apiKey` 經 pi-ai 的 `createModels({ authContext })` 傳進去：soma 的 `env()` 先問 pi-ai 預設的環境變數查詢，`ANTHROPIC_API_KEY` 沒設時才回設定檔的 key。provider 依序找 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_OAUTH_TOKEN`、`ANTHROPIC_API_KEY`，所以任何一個環境變數都蓋過設定檔。沒有用 pi-ai 的 credential store，因為存進去的憑證會蓋過環境變數（pi-ai README 的 Credential Store 一節），優先順序就反了。
- **權限。** 設定檔裡有 key 或 token，而且群組或其他人可讀時，啟動會印出警告，請 `chmod 600`。
- **`mcp.json` 仍是獨立的檔案**，格式見待決事項第 5 點。

## 介面的下一步：互動與閱讀

2026-10-22 決定：下一個介面不以通道（cc-mobile、shikigami）來選，而是分兩個方向評估——互動方式（按鈕、選項、語音）和閱讀方式（純文字以外的圖片、網頁、報表）。shikigami 的本質是桌面助理，它的語音屬於互動方式，呈現可以和 cc-mobile 共用同一套網頁。

依 Bot API 10.3（2026-08-24）的文件，Telegram 本身就能承接大部分需求，所以客戶端 socket（M4）和獨立的網頁客戶端再往後延：

- **互動**：inline 按鈕的 `callback_data` 上限 64 bytes，按下後可用 `editMessageReplyMarkup` 改寫原訊息（[Bot API](https://core.telegram.org/bots/api#inlinekeyboardbutton)）；語音以 `getFile` 下載，上限 20 MB，不附轉文字（[getFile](https://core.telegram.org/bots/api#getfile)）。
- **閱讀**：`sendRichMessage`（10.1 新增）支援表格、標題、可收合段落和按鈕，上限 32,768 字（[sendRichMessage](https://core.telegram.org/bots/api#sendrichmessage)），哪些客戶端版本會渲染沒有文件；一般 `parse_mode` 沒有表格和清單，上限 4096 字。Mini App 只要求 HTTPS 網址，`initData` 在本機以 bot token 驗證（[Web Apps](https://core.telegram.org/bots/webapps)），只靠 Tailscale 連線是否可行未實證。
- **核心不變**：核心照舊只產出一份有結構的文字回答，由介面卡轉成 rich message，「怎麼呈現由介面卡決定」不變。

順序如下，每一步一個可觀察的結果：

1. **把人的回答轉給等待中的 agent。** 派工規則禁用 AskUserQuestion，agent 要問人時寫「結果：需要你」並結束這一輪；`reply` 工具把人的回答當成下一個 prompt 送給它，下一個結果照舊由彙報送回（2026-10-22 完成，人在終端機的驗收已跑過）。
2. **Telegram 按鈕回答卡住的提示。** 模型轉給人的提示附上選項按鈕，人按下後由核心直接送給 agent，不跑模型（2026-10-22 完成，手機上的驗收已跑過）。
3. **報告改用 rich message。** 先在手機上實測渲染。
4. **收語音並轉成文字。** 語音轉文字跑在 GPU 工作站。
5. **Mini App 雛型。** rich message 不夠用時才做，先驗證只靠 Tailscale 能否打開。

### 多個介面時推給誰

2026-10-23 決定，等第二個人類側介面接上時才實作；目前「通知」仍由各介面卡自己推。每個介面都推一次會吵人，而介面卡互不 import，看不到人此刻在別的介面上，所以推給誰由核心決定，依據是人最近一次輸入的 `entry.kind`。

- **只管核心主動發出的推播**：`notice`，以及 `PUSHED_FAILURES` 那幾輪的失敗。人發起的那一輪照舊只送回發起它的介面卡。
- **推播目標**：15 分鐘內有輸入的介面；沒有就推給預設管道 Telegram。其他介面照樣收到內容，但不響，Telegram 用 `disable_notification`。
- **升級**：`question` 和失敗推出後 15 分鐘內，人沒有回答那個提示、也沒有在任何介面輸入，就再推一次到 Telegram；目標本來就是 Telegram 時不升級。報告不升級，沒人看就留在歷史裡。
- **答完就收起**：在一個介面回答了提示，其他介面的同一則拿掉按鈕（Telegram 用 `editMessageReplyMarkup`）。
- 不推測使用者偏好：訊號太少，猜錯的代價是漏掉需要人的通知。工作在 obw 卡 `multi-interface-push-target`。

## 里程碑

每個里程碑都只有一個可觀察的結果。

- **M0 Node 冒煙測試。** 在 Node 上跑一個最小 durable 任務：`sleep` 到時、`kill -9`、重開、`resume()`、任務續跑。沿用程式碼的三個 Bun API 換成 `node:net`、`node:fs`、`node:child_process`。這一步同時產出 M2 要用的骨架。
- **M1 派工能撐過崩潰。** 只做核心、herdr 介面卡和終端機客戶端（含 OSC 7501 發送）。驗收：派出兩件工作、`kill -9` 核心、重開；其中一件在核心停掉期間做完，重開後仍會被回報，而且沒有重複啟動 agent。`kill -9` 要包含「派工已送出、agent 尚未列出」的空窗。
- **M2 排程、彙報與記憶。** 驗收：`schedule` 排一件兩分鐘後的事，核心中途重啟，時間到仍只執行一次；十分鐘彙報有新完成的工作才叫醒模型，等待期間重啟不漏報、不重複報；記憶 section 在下一輪請求出現在系統提示裡。
- **M3 Telegram。** 這是最小的人類介面，在手機上驗證報告的品質。
- **M3.5 email 與行事曆。** pi-mcp 轉接層加上選定的 MCP server。驗收：在 Telegram 問「今天有什麼會」得到正確答案。
- **M4 客戶端 socket。** 給程序外的介面卡用。
- **延後：cc-mobile 助理分頁、shikigami 改成客戶端。** 2026-10-18 決定先做 soma 本身的能力；這兩個專案的修改延後，或之後把它們的功能直接移植進 soma。cc-mobile 助理分頁於 2026-10-24 取消，見「已決事項」。
- **M5 rex 介面卡。** 先做四個前置改動，每個獨立驗收：讓 `src/main.ts` 依設定選 agent 側介面卡，今天它寫死 herdr（`src/main.ts:49`）；把 herdr 介面卡裡的 Claude 畫面解析、transcript 讀取和機庫上限搬到介面卡共用的模組，`test/layering.test.ts` 加一條允許的案例；把核心和 port 裡的 `herdr:` 前綴（`src/core/extensions/dispatch/bridge.ts:18`、`src/ports/human.ts` 的 `PUSHED_FAILURES`、叫醒模型的文字開頭）改成與介面無關的 `agent:`；照「rex 的實作」改核心 `observe` 的 seq 語意。接著新增 `src/adapters/rex/` 實作 AgentPort。驗收：用真 rex 重跑 `smoke/dispatch.ts` 和 `smoke/bridge.ts`，前者要保留「機庫裡只有一個該名 window」的斷言，後者要在不按鍵的情況下通過信任對話框；另外量一次讓權限提示停在畫面上 60 秒、再讓 agent 閒置 60 秒，各收到幾個 `program_status_changed`，寫進「rex 的實作」。herdr 介面卡保留，前置改動完成後它也要通過原本的兩支 smoke。
  - **Done 2026-10-27**, checked against rex 0.0.1792787366-g623b2d and Claude Code 2.1.311. `node smoke/rex-dispatch.ts` passed with the one-window-per-name assertion, and `node smoke/rex-bridge.ts` passed in a fresh untrusted repo with no key pressed; the rex runs of these replace the two original smokes on rex, since `smoke/dispatch.ts` and `smoke/bridge.ts` drive herdr. The measurement is in「沒有轉換計數器」. On herdr, `node smoke/bridge.ts` passed on a throwaway herdr session; `smoke/dispatch.ts` on herdr was not fixed, by the human's decision on 2026-10-27: it fails on main 884aa16 at its own step 3, where it answers the trust dialog with Down and Enter and then times out waiting for idle, and dispatch goes through rex instead.
- **M6 原生 tty 介面卡。** soma 自己開 pty 跑 agent，回應 7501 探測並解析回報，用終端模擬器讀畫面回答提示。驗收：派一件工作、讓它卡在權限提示、從 Telegram 回答、讀到結果；再派一件、`kill -9` soma、重開，這件工作被記成 agent 不見了並通知人一次，不重複通知。
  - **pty and emulator, picked 2026-10-27** on macOS arm64 with Node 24.13.0 and Claude Code 2.1.311, by a throwaway prototype that is not in this repo. The pty is `@lydell/node-pty` 1.1.0 (MIT), a smaller build of node-pty: the binary comes in a per-platform optional dependency (`@lydell/node-pty-darwin-arm64`, about 170 KB), with no install script and no compiling, so a release still needs no build step, though it now carries a native prebuild. The emulator is `@xterm/headless` 6.0.0 (MIT, pure JS): `term.parser.registerOscHandler(7501, …)` sees both the probe and the reports, the adapter answers the probe `?` by writing `ESC ] 7501 ; ? ESC \` to the pty, and `term.onData` goes back to the pty so the emulator answers the other terminal queries itself. Claude Code then reported `idle` once its trust dialog was answered, `working` on a prompt and `done` when it finished, all with `app=claude-code`; before the dialog it sent only `state=clear`. `buffer.active` read as `translateToString` matched the screen, the trust dialog included. Rejected: `node-pty` 1.1.0 itself, which is 64 MB unpacked, runs an install script, and whose `spawn-helper` prebuild came out of npm without its exec bit, so `spawn` failed with `posix_spawnp failed` until it was `chmod +x`. Not tried: a pty through `script(1)` with no dependency, and other emulators. Two facts for the adapter: claude's trust dialog defaults to "No, exit", so Enter alone quits it; and claude inherits the spawning process's environment, where a `CLAUDE_CODE_CHILD_SESSION` marker turns off transcript saving, so the adapter has to drop it. Not checked: Node 22, and Linux, where the `linux-*` packages exist but were not run.
- **常駐服務。** 2026-10-26 決定：soma 由使用者層級的 launchd（LaunchAgent）啟動並在崩潰後重啟，人類側只用 Telegram，終端機介面等 M4。launchd 跑的是 release，不是 dev repo：用 `git archive` 把一個 commit 解開到 `~/.local/share/soma/releases/<sha>/`，在那裡執行 `npm ci --omit=dev`，再把 `current` symlink 指向它。這樣做不需要建置，因為 `tsconfig.json` 開了 `erasableSyntaxOnly`，正式依賴也沒有原生模組（SQLite 用 Node 內建的 `node:sqlite`）。dev 和 prod 分成兩條路徑：dev 跑 repo，prod 跑 release，每個環境一份設定檔。db 和 Telegram bot 不能共用，所以 dev 用自己的 db、預設不開 Telegram；herdr 的 fleet 機庫兩邊共用，因為事件橋會忽略不是自己派出的 agent（`src/core/extensions/dispatch/bridge.ts:52`），代價是並發上限合算，兩邊也不能派同一張卡。有兩個前置改動，各自驗收：一是新增 `SOMA_CONFIG` 環境變數選設定檔，沒設時仍讀 `~/.config/soma/config.json`，也就是 prod 的設定；二是 reflection 的 repo 路徑可以設定、也可以關掉（`src/config.ts` 的 `repo` 與 `reflection`），沒設 `repo` 時取程式碼的位置，release 目錄不是 git repo，code-change 卡片無處可派，而 dev 實例的反省只會開出雜訊卡片。plist 的 `TMPDIR` 照「整體形狀」一節設定。驗收：所有終端機都關掉時，Telegram 仍得到回答；`kill -9` 後 launchd 把它拉回來，重啟前派出的工作照常回報；herdr 不在時 soma 不會卡死，herdr 回來後恢復服務。工作在 obw 卡 `resident-service`。
  - **Done 2026-10-26.** All three checks passed. The herdr one ran on a throwaway herdr session with a dev instance, so fleet's agents kept running: with herdr down soma exits 1 within about a second rather than hanging, and answers once herdr is back. Two things were not observed: launchd restarting that exit 1 every 10 s (inferred from `KeepAlive.SuccessfulExit=false`), and herdr going away while soma is already running.
  - **Install.** The plist is not in this repo; it is `~/Library/LaunchAgents/dev.musingfox.soma.plist`, modelled on `dev.musingfox.herdr-fleet.plist`. Its keys: `ProgramArguments` is only `~/.local/share/soma/releases/current/bin/soma` (pointing at node would make macOS list the background item as "Node.js Foundation"); `PATH` starts with the fnm node that `package.json` accepts and includes the directory of `uvx`, without which the Google MCP server does not start; `TMPDIR` is `getconf DARWIN_USER_TEMP_DIR`; `WorkingDirectory` is `~/.local/share/soma`; `RunAtLoad`, `KeepAlive.SuccessfulExit=false`, `ThrottleInterval` 10; `ExitTimeOut` 40, longer than Telegram's 30 s long poll; both log paths `~/Library/Logs/soma.log`. Before loading it, prod's config `~/.config/soma/config.json` (chmod 600) sets `repo` to the checkout and `scripts/release.sh` has made `current`. Then the human runs `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.musingfox.soma.plist`; auto mode blocks it.
  - **Release.** `scripts/release.sh [ref]`, then `launchctl kickstart -k gui/$(id -u)/dev.musingfox.soma`. To roll back, release a commit that is already unpacked and restart again.
- **之後** 再視需要做 ACP 和 HTTP 兩種 agent 介面。

先不做的事：一開始就把三種 agent 介面寫齊、做通用的外掛框架（port 要有，註冊表和動態載入不要）、上雲。

## 已決事項

2026-10-18 決定：

- **執行環境先用 Node。** Pi 官方只支援 Node，沿用程式碼的三個 Bun API 各一行可換，也不必自己維護儲存介面卡。之後要轉 Bun 的評估如下。
  - 好處：工具鏈和 cc-mobile 一致；啟動快；可以打包成單一執行檔。
  - 代價：要寫並維護 `bun:sqlite` 介面卡（Node 版 201 行）；pi-durable 整個 harness 和 pi-ai 的串流在 Bun 上都未驗證；pi-durable 是實驗版，每次升版都要在兩個執行環境各驗一次。
  - 轉換要動的地方：加一個 SQLite 介面卡、把三個 node 呼叫換回 Bun API、重跑 M0 的冒煙測試和 M1 的 `kill -9` 驗收。
  - 重新評估的時機：M2 做完、harness 用到的 API 面積已知之後。
- **模型認證用 Anthropic API key。** 理由見「外部依賴」。
- **卡住時由模型判斷要不要轉給人**，`kind=auth` 除外；判斷和理由記進派工清單。
- **完成回報走每十分鐘的定時檢查**，有新完成的工作才叫醒模型寫短報告。例外（2026-10-23）：結果是「需要你」或「失敗」，或人十分鐘內碰過的「完成」，事件橋不叫醒模型就直接通知人，因為有人在等；2026-10-22 Telegram 驗收時，agent 做完後報告晚了九分鐘才到。

2026-10-24 決定：

- **兩端的介面卡都是可選的。** 使用者依自己的習慣選，連原生 tty 也要可行；不同介面卡的功能不同，由使用者自己取捨（見「agent 側介面卡的能力差異」）。新增 rex 介面卡（M5）和原生 tty 介面卡（M6），herdr 介面卡保留。AgentPort 本來就用 OSC 7501 的詞彙（`src/ports/agent.ts:1`），而 Claude Code 在 rex 裡原生回報 7501，不用 `herdr integration install claude`。rex 的實測事實與要補的缺口見「rex 的實作」。
- **維護分優先級。** maintainer 積極維護自己在用的介面卡，其他的跟著核心改動過測試，但不保證修 agent 端或平台升版造成的問題。
- **核心不綁定任何一種介面。** soma 之後可能開放給別人用，別人的習慣不一定和 maintainer 相同。所以 port 和核心不出現任何介面的名字（M5 的前置改動拿掉 `herdr:` 前綴就是為此），介面專屬的做法都留在介面卡裡，別人也可以為自己的終端寫一個介面卡。
- **不再需要 cc-mobile。** 不改造它的理由是它的 `server/herdr/` 約 5.7k 行非測試程式，herdr 的詞彙已經滲進它的 wire protocol 和推播邏輯，改造的成本接近重寫。soma 原本規劃的 `cc-mobile-socket/` 和 `cc-mobile-launch/` 介面卡也取消。cc-mobile 面向使用者的功能分成三類：
  - **soma 接手**：派工到機庫、卡住時推播、對派出去的 agent 按權限或問題的選項（Telegram 按鈕）。完成通知由十分鐘彙報加緊急即時通知取代 cc-mobile 的 45 秒合併推播。
  - **終端客戶端接手**：鏡像 session、串流顯示、quick actions、自動完成、主題等純介面功能，由 Rex 的客戶端負責。
  - **放棄**：對人自己開的 pane 按權限、對任何 agent 送自由文字、中斷、在手機上挑目錄開 session、傳圖片、寫入稽核檔、機庫離線推播、`GET /api/cards`。前三項在 Rex for iOS 可用後由它接手，其餘不再提供。
- **手機上的空窗。** Rex for iOS 還不在公開測試，推播到手機也還沒有。在它們可用之前，手機上只能經 Telegram 回答 soma 派出去的 agent 的提示；人自己在終端開的 agent 卡住時，手機收不到通知，也沒辦法回答。

Decided 2026-10-27:

- **A completion is identified by the transcript's last record, not by timing.** A turn whose transcript ends on a user record recorded a new 未知 turn at every re-stamp, and two adapter-level fixes that told a re-stamp from a new turn by timing both left holes. So the contract changed instead: `AgentResult` is `{ id, text? }`, `id` the `uuid` of the transcript's last record, whoever wrote it (see「事件橋」, M5-2d).
- **Web search and page fetch are two read-only core extension tools, not MCP servers.** Decided with the human for the `web-search` card. The rule that external capabilities come in through pi-mcp (「核心的組成」, 外部工具) gets one exception: a tool that only reads, has no side effects, and whose output soma must shape may be a core extension, with the provider's details kept inside that extension.
  - **Search** is `web_search`, which POSTs to Exa's `/search` with `contents.highlights` and returns title, URL, date and highlights per result ([Exa highlights](https://exa.ai/docs/search/highlights), [Exa search quickstart](https://exa.ai/docs/search/quickstart)). The tool name and output carry no Exa vocabulary, so another provider can sit behind it later. Rejected: Exa's MCP server over stdio with `ENABLED_TOOLS=web_search_exa` ([exa-mcp-server README](https://github.com/exa-labs/exa-mcp-server/blob/main/README.md)); it needs no code, but Exa names and shapes the tool, the MCP adapter forces `replay: "unsafe"`, and prod gains an `npx` child process.
  - **Fetch** is `web_fetch`: Node's `fetch` gets the HTML, linkedom parses it, and `Defuddle(document, url, { markdown: true })` from `defuddle/node` returns the main content as markdown ([Defuddle README](https://github.com/kepano/defuddle/blob/main/README.md), Node.js section). Only `http` and `https` URLs. Rejected: the `defuddle` CLI as a child process, which starts a process per call and must be on prod's PATH.
  - **Credentials.** The Exa key is `exa.apiKey` in soma's config file, as `anthropic.apiKey` is, and the chmod 600 warning (`src/config.ts:113`) extends to it; `EXA_API_KEY` overrides it. Without a key, `web_search` is not registered and soma starts normally. The key never appears in tool output or logs.
  - **Limits.** `web_search` returns 5 results by default and at most 10. `web_fetch` cuts the markdown at 20,000 characters and says it did. Both time out after 15 s, but the timeout covers only the request: `web_fetch` then parses synchronously and cannot be aborted, so it reads at most 512 KB of the page and says when it read less. Dense 512 KB parsed in 1.7 s and dense 1 MB in 4.8 s, while a 416 KB GitHub page lost its README at 256 KB (measured 2026-10-27; see `FETCH_MAX_BYTES`). A worker thread would make parsing abortable; the human chose the cap. Every failure is an `isError` result the model can read, as the MCP adapter's are.
  - **Local addresses are not blocked.** `web_fetch` can read localhost and LAN addresses; the human does not count this as a risk for a single-user soma.
  - **Replay is `safe` for both.** pi-durable reruns a call after a crash only when it is declared safe (`node_modules/@earendil-works/pi-durable/README.md:181`), and a read has nothing to repeat.
  - **No deferred tools yet.** soma defines 18 tools of its own; two more do not change the plan in「外部依賴」(MCP) to defer tools and install `createToolSearchExtension()` once shikigami-bridge's tools arrive.

## 待決事項

1. **（已決，2026-10-18）派工要怎麼接 herdr。** 有三條路：
   - **(建議 M1 採用) 呼叫 cc-mobile 現成的 `POST /api/launch`。** 這條路由依序做驗證 bearer token、檢查、進佇列、建 worktree（`launch.ts:196`）、重新檢查（`:212`）、建 session、寫綁定檔、送提示（`server/launch.ts:196-349`）。好處是 soma 不用複製任何程式碼，並發上限自然共用，obw 回寫掛鉤應照常運作（未追查）。代價有兩個：soma 依賴 cc-mobile 程序在線，而 M4 又讓 cc-mobile 成為 soma 的客戶端，兩個程序都不能把啟動卡在對方身上；派工以 obw 卡片為單位，沒有卡片的臨時工作走不了這條路。
   - **把純函式複製進 soma**，註明來源 commit。代價是兩份程式碼會分岔，並發上限也要另外協調。
   - **抽成共用套件**，由兩邊共同依賴。這最乾淨，但要先改 cc-mobile，適合留到 M4。

   讀狀態和讀對話紀錄不經過派工路由，所以 M1 的事件橋仍然需要 herdr 的連線與訂閱程式碼。

   2026-10-18 決定：M1 改由 herdr 介面卡直接派進 `fleet` 機庫 session，用 herdr 自己的 `worktree.create` 開 `fleet/<card>` 分支，再 `agent.start` 帶 `--session-id`。理由是 `/api/launch` 要 soma 持有 cc-mobile 的 launch token 並依賴 cc-mobile 在線，而 herdr 介面卡本來就要寫；並發上限照 cc-mobile 的算法計算機庫裡在跑的 agent 數，兩邊算到的是同一批。`/api/launch` 留作 AgentPort 的另一個實作（2026-10-24 取消，見「已決事項」）。
2. **shikigami 跑在哪台機器。** 如果和核心同一台，就在本機直接連；如果在筆電上，就經 Tailscale 連，和 cc-mobile 被手機連的方式一樣。
3. **報告存放位置，以及要不要另有一份每日總結。** 十分鐘短報告寫進 `notice` 紀錄由介面卡分送；是否再寫進 Obsidian vault 的日記或對應的 obw 卡片，待定。
4. **沒有 obw 卡片的臨時工作怎麼派。** `POST /api/launch` 以卡片為單位；要嘛 soma 先替臨時工作建卡，要嘛走自己的派工路徑。2026-10-24 取消 `/api/launch` 之後只剩後兩者，派工工具目前也以卡片為單位。
5. **（已決，2026-10-18）email 與行事曆用哪個 MCP server，憑證放哪裡。**

   2026-10-18 決定：用 [workspace-mcp](https://github.com/taylorwilsdon/google_workspace_mcp)（MIT，未封存，v2.1.0 於 2026-10-09 發布），一個 stdio server 同時提供 Gmail 與 Calendar，以 Google OAuth 登入個人帳號。啟動指令是 `uvx workspace-mcp@2.1.0 --single-user --permissions gmail:readonly calendar:readonly`；2026-10-18 經 soma 的轉接層實際啟動，`tools/list` 只列出讀取類工具，其中有 `search_gmail_messages`（`query` 直接交給 Gmail，可用 `is:unread is:important`）和 `get_events`（`time_min`、`time_max`）。每個工具都有 `user_google_email` 參數。只加 `--single-user` 時這個參數仍是必填，而且帶了憑證目錄裡沒有的帳號就直接失敗、不會改用別的憑證（workspace-mcp 2.1.0 `auth/google_auth.py` 的 single-user 分支）；所以 `env` 還要設 `USER_GOOGLE_EMAIL`，server 會把參數改成選填並自動填入這個帳號（`core/server.py` 的 `USER_GOOGLE_EMAIL` 處理，2026-10-18 經轉接層實測 `tools/list` 的 `required` 已不含它）。

   憑證不進 repo。soma 讀 `~/.config/soma/mcp.json`（環境變數 `SOMA_MCP_CONFIG` 或設定檔的 `mcpConfig` 可覆寫路徑），格式是 `{"servers": {"<名稱>": {"command", "args", "env"}}}`。server 自己的憑證路徑寫在 `env` 裡：OAuth client 用 `GOOGLE_OAUTH_CLIENT_ID`、`GOOGLE_OAUTH_CLIENT_SECRET`（或 `GOOGLE_CLIENT_SECRET_PATH` 指向 client_secret.json），token 目錄用 `WORKSPACE_MCP_CREDENTIALS_DIR`，建議設為 `~/.config/soma/google`；帳號用 `USER_GOOGLE_EMAIL`。Google OAuth app 停在 Testing 模式時 refresh token 七天後失效（[google-calendar-mcp README](https://github.com/nspady/google-calendar-mcp)），要發布成 production 才不用每週重新授權。

   沒選的候選：
   - Google 官方的 [Gmail](https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server) 與 [Calendar](https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server) MCP server 還在 Developer Preview，只有 Streamable HTTP，個人帳號能否加入未驗證。正式發布後可以改用，轉接層要先加 HTTP 與 OAuth。
   - [@cocal/google-calendar-mcp](https://github.com/nspady/google-calendar-mcp) 加 [@klodr/gmail-mcp](https://github.com/klodr/gmail-mcp) 是兩個 Node server，要分開設定憑證；後者只有一位維護者。
   - [GongRzhe/Gmail-MCP-Server](https://github.com/GongRzhe/Gmail-MCP-Server) 已封存。

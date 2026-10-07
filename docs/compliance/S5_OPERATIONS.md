# S5 启用与隔离恢复操作单

策略见 [S5_POLICY.md](S5_POLICY.md)，验收范围见 [S5_ACCEPTANCE.md](S5_ACCEPTANCE.md)。本单是后续维护操作说明，本轮未执行生产部署、真实注销、真实远端删除或通知。不要把本地开发环境的自动初始化用于生产。

## 首次启用

1. 固定完整候选提交，保留既有一致性备份，安排维护窗口并停止服务和其他写入进程。以下 `--offline` 是操作者对停写的明确断言，程序不会证明所有进程均已停止。
2. 私下核对当前生效的 DATA_DIR、STATE_DB_PATH 和服务用户。为独立注销账本选择 **运行数据树、公开目录、release、备份与恢复目录之外** 的绝对路径；父目录须已存在且服务身份可写。不要使用符号链接、路径大小写别名或 Windows 未验证的 ACL。该目录独立保护、保存并另行灾备，普通运行备份不会包含这份权威账本。
3. 仅首次初始化，使用服务身份运行：

```sh
node scripts/initialize-deletion-ledger.mjs --offline \
  --state-db="$S5_STATE_DB" --data-dir="$S5_DATA_DIR" \
  --ledger-dir="$S5_LEDGER_DIR"
```

这些变量须先由维护者设为已核准的实际绝对路径。新账本目录不得已存在；数据库必须已存在且私密。成功建立 SQLite 谱系绑定与 0700/0600 账本，不证明初始化前全部历史注销已经收录。中途失败不要删除账本后重建，先核对数据库绑定与账本原件。

4. 服务环境加入 `DELETION_LEDGER_DIR`，指向同一独立目录，再运行候选。生产未配置且未初始化时，其他服务可启动，但注销返回 `503 ACCOUNT_DELETION_UNAVAILABLE`；已有绑定却缺路径、缺账本或绑定不匹配时不能启动。开发／合成测试环境才允许自动在 DATA_DIR 旁首次建立独立目录。
5. 候选启动先恢复既有发布事务，再重放全部注销意图。检查 `/api/v1/health` 的 `accountDeletion.configured/pending/ledgerSequence`，并私下查看 `account_deletion_jobs` 的状态和固定错误码。pending 账号仍不能登录；进程每分钟继续重试，重试也参加一致性备份请求门禁。服务整体健康不等同全部注销作业完成。
6. 用真实运行数据重新构建发布隐私页。已知原默认告知自动升级；自定义内容保留，后台隐私响应 `customNeedsReview:true` 的内容须人工核对。现行账号规则始终先展示，不据此认定自定义文案或生产 HTML 已验收。
7. 用合成账号复跑完整注销、跨重启、头像、支付回调、日志及备份恢复矩阵后再关闭生产验收。原 S2 私密备份桶未启用仍独立留待，不因新增代码而视为接通。

首次启用后，不要直接回退到不识别注销账本的旧 S2/S3/S4 服务，也不要用旧 DATA_DIR 覆盖独立账本。回退需要保留全部后续注销意图、运行兼容 S5 的代码并重新核对；必要时保持停服修复。

## 新备份与恢复重放

启用后完整备份记录 `deletionLedgerHead`。SQLite 已绑定却缺账本、账本错谱系或试图把权威账本／恢复控制文件混进快照时拒绝打包。备份仍不包含头像等远端资源。旧包没有水位时，恢复重放不会自动判通过，不能伪造历史水位。

1. 按原完整备份流程解密校验并恢复到全新私密目录。保留根目录和 `data/` 下两份 `.restore-quarantine`，旧会话清空；不覆盖当前运行目录。
2. 停止恢复目录所有写入。从**仍独立保存的最新权威账本**核对当前头，把仅包含 `{lineage,sequence,hash}` 的 JSON 保存为恢复目录以外的 0600 常规文件。初始化时打印的 genesis 或备份内水位都不能作为后续最新头。程序核对一致性，不自动证明操作者选取的来源真的最新。
3. 使用恢复候选的相同 Node/依赖运行：

```sh
node scripts/replay-restored-deletions.mjs replay --offline \
  --destination="$S5_RESTORE_DIR" --ledger-dir="$S5_LEDGER_DIR" \
  --fresh-head-file="$S5_FRESH_HEAD_FILE"
node scripts/replay-restored-deletions.mjs verify --offline \
  --destination="$S5_RESTORE_DIR" --ledger-dir="$S5_LEDGER_DIR" \
  --fresh-head-file="$S5_FRESH_HEAD_FILE"
```

4. 查看退出码和固定失败码。重放会核对全部账号实例、处理历史作业的订单键，重做身份／内容清理并推进已知账号序号。缺失初始化前证据、错误谱系、实例冲突、旧／缺头或头像未清不能当成功。包含头像的恢复仅登记待删除资源，离线程序不连接远端；先完成并核对源站清理，再重放并重新验证 proof。
5. `verify` 重新核对当前头与 SQLite／业务 JSON 哈希。任何状态变化、头变化都须重跑；`replayVerified` 也不代表外部最新性、第三方缓存或完整生产恢复都已验证。两个程序都不会解除隔离。仅在维护者核准当前 proof、远端事项、实际配置与静态发布后，另行安排启用；本轮没有授权或执行该操作。

## 头像上传结果不明的处理

新头像先持久登记再 PUT。已确认 PUT 完成的已登记资源可自动删除并重试；崩溃或网络错误留下的 `upload_state=uncertain` 资源会保留键，即使一次 DELETE 成功也不报注销完成，以防旧 PUT 稍后才提交。不能用等待一段时间、单次 HEAD 404 或 DELETE 成功来推断旧 PUT 已终结。

若独立证据已确认旧远端请求终结，维护者可停服后，对精确资源键记录确认：

```sh
node scripts/confirm-avatar-upload-settled.mjs --offline \
  --confirm-remote-put-terminal --state-db="$S5_STATE_DB" \
  --avatar-id="$S5_AVATAR_ID" --evidence-file="$S5_PRIVATE_EVIDENCE_FILE"
```

证据文件必须私密、非符号链接；工具只保存证据 SHA-256 和时间，且仅允许已注销账号的待清理资源。此命令记录**操作者确认**，不自动认证外部证据，也不删除源对象。随后还须运行正常清理／重试并读回结果。不能取得可靠证据时继续保持 pending。

新 PUT 使用 `Cache-Control: no-store`；已有一年缓存、外部缓存及旧代码从未登记的孤立对象不能据此宣称已删除。无精确订单键的历史公开捐助记录同样需人工核对，不能按同名猜删。上述边界须在生产回执中逐项保留。

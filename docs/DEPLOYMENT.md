# Deployment safety

<a id="ai-rollback-guard"></a>

## 2026-10-25 AI修复候选与旧r3回退边界（本地，未部署）

本候选基于逐文件校验的r3源码和e97a2f4交付增量；修复AI正文读取链、输入/上下文/适用范围和供应商凭据绑定。不变更数据库schema、社区基数、S3/S5或生产数据；发布前仍需核对当前运行文件的before哈希。原工作区与运行目录未被修改。

旧r3不支持微信地址，会改写为DashScope并保留Key。**不得保存微信配置后仅切回旧release并恢复AI问答。** 新代码不会追溯修复旧二进制。支持的默认回退保持普通指南可用、AI关闭，直到回到兼容版本或完成独立核准的配置恢复。

1. 先冻结AI管理配置写入并停止新AI请求，确认或等待在途调用退出；依现有维护流程保存当时一致备份和当前AI配置，秘密只进入受限/加密保管，不进交接包。
2. 在当前有效配置中持久设置`settings.enabled:false`。不能仅清空Key：旧r3会回填环境种子。确认实际service使用的DATA_DIR与配置文件，不猜路径、不读取并回显秘密。
3. 使用本候选的只读预检：`node scripts/check-ai-rollback.mjs --settings /var/lib/nkustudy/json/ai-provider-settings.json`。路径必须来自有效配置核验。只有私有普通文件、version1且enabled严格为false才PASS；该PASS仅证明AI关闭前提，不证明数据恢复或应用切换成功。
4. 保持配置写入冻结，按已核对的精确systemd drop-in切换到已核准r3基线；先核对全部有效drop-in顺序和备份，禁止`zzzzzz-*.conf`等通配删除，也不能靠增加z字符猜哪个配置会生效。
5. 启动前后重新执行相同关闭预检并核对实际进程cwd、health、guides、无凭据401及已授权测试身份的AI不可用结果；不为验证自动创建管理账号或调用真实模型。保持AI关闭。恢复AI需另行核准匹配的地址/模型/凭据并完成端到端验证。

如需回退后立即保持AI可用，必须另交匹配旧版provider的完整配置与测试证据，不能复用微信Key到DashScope。本轮不执行任何回退、配置写入或凭据轮换。

管理页“测试连接”现提交当前完整表单，并与保存共用地址/Key约束；部署时须通过现有受控静态发布流程更新管理页资产。只切换Node而保留旧管理页，会继续提交旧版测试表单；不要把本地夹具构建输出覆盖生产内容。

现有部分全量测试/fixture构建脚本含递归清理，按本轮项目删除边界未执行。相关AI/请求读取/配置测试采用内存、回环HTTP及精确已知临时文件清理；全量候选与生产端到端/手机/50题验收另行记录，不以专项通过替代。

This repository is a source candidate, not authorization to deploy. Production data and secrets remain outside every release. Website administration is the only content-management surface; future `/api/v1` routes are public/user-facing only.

<a id="community-support-rollout"></a>

## 2026-10-24 公共历史基数升级（r3，待服务器执行）

已上线来源为 `/opt/nkustudy-releases/20261024-community-ui11-r2`，本次只改变公共总量，不改变个人花币或等级。交付增量绑定全部220个已部署源码文件，复制完整现行应用至独立r3目录后应用；保留依赖、UI11页面、资源和运行数据路径。参考资料991/评价1477不写死，迁移从当时权威公开目录和评价源重新核验。

1. 一批脚本先在服务运行时完成来源校验、候选安装、以nkustudy身份的合成测试和路由核验。只要失败就不进入迁移。
2. root将现行env、unit/drop-ins和主Caddy配置保存在0700目录、0600文件中；不输出秘密内容。停掉现有单写服务并确认inactive/MainPID=ControlPID=0之后，由nkustudy执行 `scripts/backup-community-support-baseline.mjs`，复用加密备份与解密读回校验。覆盖SQLite全部表、运行JSON和私密应用配置；独立S5权威账本保持原处，只把checkpoint写入运行备份。外部资源不复制。
3. 同一oneshot单元在备份成功后才执行 `scripts/migrate-community-support-baseline.mjs --apply`。该脚本也支持离线 `--preview`、`--status`；所有写者停下由外层执行器保证。只读SQLite可能创建锁辅助文件，但不改业务数据或schema。
4. 唯一迁移标识为 `community-baseline-20261024-v1`。一个SQLite立即事务完成旧规则同步、同sequence历史公共投影、基数字段与回执、revision推进；个人统计前后摘要必须一致。重复执行返回原回执，不重复加数；不重置epoch、JSON sequence或baseline_review_ids。
5. 新服务保留三个功能开关为1，并持久设置 `COMMUNITY_SUPPORT_BASELINE_REQUIRED=1`。只有迁移回执存在且完整时才开放统计。恢复了迁移前备份、回执缺失或不一致时关闭能力，不自动重新初始化基数。
6. 核验健康、home最终公共总量、401鉴权、运行路径和迁移回执。失败或连接中断后运行整批脚本的status，保留全部候选、回执、日志与备份，不重复apply、不清文件。迁移可能已提交时固定新代码并关闭功能；不能退回r2，因为其旧投影即使关功能仍会排除历史评价。

既有备份包含新增SQLite元数据；隔离恢复/重建必须保留该记录及最新下载、注销证据。`rebuildReviewProjection()`只重建评价派生数据，不重新取得资料基数，也不是一个公开入口。禁止用旧备份覆盖最新数据后声称个人贡献保持不变。

下方r2段落保留首次上线的历史流程；不能用它重新初始化已迁移的生产服务。r3的具体清单、包哈希和测试结果以随包RELEASE/校验清单为准。本地验证不是目标Linux迁移、生产账号写入或真机验收。

## 2026-10-24 花币后端 UI11 增量发布（r2）

本候选以用户从运行目录 `/opt/nkustudy-releases/20261013-ui11-70815df` 导出的 212 个源码文件为基准。原包 SHA-256 为 `126af2aa60c8a5e6f24e72ae3a426a1e703793dc776d866d0b7c5d2606fe44a1`，源码清单 SHA-256 为 `1c9830b7ca8231ebb1655d832c693280fdec85d347852c1adc771a13ca239cdc`，均已本地独立校验；目录没有 Git 元数据，不将目录后缀当作已核验完整提交。旧 `e8b1022` 仅作本地测试脚手架及 r1 开发基线，r1 全量包不得覆盖 UI11。

交付仅包含花币增量及验证器；主题/图标、管理页、备份分项及课程文件增量同步保留 UI11 原实现。导出包没有完整静态资产及运行数据，不能用它重建整站覆盖。正式接口及一致性边界见 [API.md](API.md#community-support-api)。

### 发布前准备

1. 只读核对当前服务的有效 `WorkingDirectory`、`ExecStart`，并运行增量包的 `apply_delta.py --verify-source /opt/nkustudy-releases/20261013-ui11-70815df` 校验全部 212 个源文件。任何漂移均停止，保留实际后续改动后再整合。
2. 以当前完整 UI11 应用为底准备一个尚未启用的新 release 目录，保留现有静态源资产；不要改写活跃目录。在新目录运行增量包校验后才应用所列文件，未列文件不改。继续沿用服务账号、Node `>=22.12.0`、原 SQLite/JSON 路径、Caddy 及 R2。锁文件及依赖未改；本机 macOS 依赖软链不随包发布，目标机使用自己经过验证的 Linux 依赖。
3. 在隔离合成环境先运行 `npm run test:community-support`、`npm run check:api-docs`、`npm run check`。不要给测试注入生产环境文件；测试会创建临时合成目录和短时回环 HTTP 服务，不访问真实微信/R2，不发送真实通知。保留输出作为本地或目标 Linux 证据，不能冒充生产验收。
4. 按现有受控流程取得一致备份，包含运行 JSON、SQLite（不能遗漏 WAL）及必要配置；独立 S5 权威注销账本单独保留，不包含在运行快照内。UI11 支持分项备份，部署备份必须明确 `siteData=true`、`serverConfig=true`，只同步课程文件不算完整运行备份。源码包不能覆盖运行 JSON、SQLite、凭据或资源。后端测试和真实环境预检是不同门禁。

### 安装与首次启用

三项环境变量均默认关闭：

```ini
COMMUNITY_SUPPORT_ENABLED=0
COMMUNITY_SUPPORT_DOWNLOAD_REPORTING=0
COMMUNITY_SUPPORT_PERSONAL_STATS=0
```

先保持这三个值，按既有 release 切换流程部署代码，核对服务、首页、登录和正常资源接口。未初始化的关闭状态不会创建贡献表或历史基线；首页的 `community_support` 为 `{version:1,enabled:false}`，新统计写入为 503。

准备开始计数时，在维护窗口保持现有单写进程约束、停止所有运行数据写入并完成一致备份；将 `COMMUNITY_SUPPORT_ENABLED=1`，按已核对的 systemd 服务身份重启。启动先完成原恢复、S3 规范化与 S5 注销重放，再初始化：

- 在 `reviews.json` 添加私有 `community_support_ledger`（epoch、sequence、全部现有评价 ID 排除基线）；原评价内容、公开状态和身份规则保持。
- 在既有 SQLite 增量创建 `community_support_meta`、`community_support_downloads`、`community_support_reviews`、`community_support_cleared_accounts`、`community_support_rate_limits` 及索引。没有外部手写 SQL 部署步骤。
- 历史花币从 0 开始；初始化之后新增的评价随真实审核状态计币。此启动有明确持久写入，不能当作只读预检执行。首次初始化中断、来源或数据库缺失/不匹配时会关闭统计能力，保留原件，不自动重置；网站其他功能继续运行。

可先让两个子开关保持 `0`，仅启用公共总量。需要开放下载记账与个人查询时再分别设置为 `1` 并重启。客户端尚未接入时不要宣称已实现“下载→花币→个人等级”完整体验；后台开关不会替代客户端实现。所有新路由沿用 `/api/v1/*`，无需新域名或公网 Node 端口。

### 验收、故障与回退

- 隔离验收：并发重放同一事件 100 次只计 1；正文/归属冲突 409；401/429/503 不计数；匿名不计本人；评价待审→批准→重复批准→隐藏→恢复为 `0→1→1→0→1`；重启/开关不重置；注销及旧备份恢复后不能重新关联本人。既有自动批准仍可有效计币。
- 生产先做只读健康与能力检查，核对实际 release、三个开关、计数和 revision。真实写入联调使用维护者明确选定的账号与内容，并先核对是否会触发现有通知；本候选未授权发送通知或随意创建生产投稿。真机、真实下载完成事件与客户端页面验收另列。
- 常规回退优先设置 `COMMUNITY_SUPPORT_ENABLED=0`，保留当前代码、源标记和全部账本。关闭之后审核/注销仍维护一致性；不能删表、清记录或把旧备份直接覆盖回来。
- 首次启用前可以退回原代码。启用后旧 `e8b1022` 不维护新 sequence；不要让旧代码继续写入后又直接开启本候选。若确须代码回退，保持统计关闭，并由维护者核对期间数据变化及恢复方案。
- 来源标记损坏、SQL/JSON 对不上或正在写入时，统计返回不可用，首页保留原业务内容。不得通过删除 marker、清空表或伪造成功回执消除错误。
- 完整旧备份即使内部一致，也可能落后于已发布 revision 和新增下载。恢复前须保留最新贡献数据库/日志证据，在隔离环境核对当前权威状态、最高已发布 revision 及 S5 最新注销账本；没有完整证据就保持能力关闭。本轮没有自动跨备份补账或任意提升 revision 的管理入口。
- 共享 JSON 目录只允许一个 Node 写进程。SQLite 并发测试不授权部署多实例；额度、伪造事件与日量的产品取舍见 API 文档。

回交只需实际 release/候选哈希、服务版本、三项开关、备份/恢复结果、测试与只读接口结果、未验项。不要回传环境文件、Token、个人信息或完整原始日志。当前任务未连接生产、未执行迁移/重启、未上传小程序。

## Production fail-closed contract

Set all of these explicitly to absolute paths outside the release tree:

```ini
NODE_ENV=production
DATA_DIR=/var/lib/nkustudy/json
STATE_DB_PATH=/var/lib/nkustudy/miniprogram.sqlite
ADMIN_SECRET_FILE=/var/lib/nkustudy/admin-secret
ADMIN_ORIGIN=https://nkustudy.top
TRUSTED_PROXIES=127.0.0.1/32,::1/128
PUBLIC_RESOURCE_ORIGIN=https://resources.nkustudy.top
PUBLIC_GUIDE_CORRECTION_URL=https://nkustudy.top/feedback
PUBLIC_DIR=/var/www/nkustudy-publish/current
PUBLIC_RELEASES_DIR=/var/www/nkustudy-publish/releases
```

Before startup, create `/var/lib/nkustudy` and `${DATA_DIR}` as mode `0700`, create `${DATA_DIR}/.nkustudy-data-root` containing exactly `NKUSTUDY_RUNTIME_DATA_V1`, and install all core JSON files. Use `STATE_DB_PATH=/var/lib/nkustudy/miniprogram.sqlite` and `ADMIN_SECRET_FILE=/var/lib/nkustudy/admin-secret`; all data, database and secret files are mode `0600`. `ADMIN_SECRET_FILE` must already exist and contain at least 32 random characters. Production startup validates the sentinel, core JSON, paths, symlinks, permissions, secret and trusted proxy configuration before SQLite or mutable JSON is created.

Administrator sessions are opaque random tokens whose HMAC hashes, absolute expiry and last-use time are stored in `STATE_DB_PATH`. The defaults are a 30-minute idle timeout and an 8-hour absolute timeout; logout revokes the session in SQLite. Every non-GET `/admin-api/*` request must come from the exact `ADMIN_ORIGIN`, carry `X-NKUStudy-Admin-Request: 1`, and use the expected JSON or multipart content type. Keep `ADMIN_ORIGIN` canonical and redirect alternate hostnames to it.

## Reverse-proxy and host baseline

The public Node listener stays on `127.0.0.1:8787`. Caddy is the only public HTTP entry point. Install `ops/Caddyfile.s2-security-headers` and `ops/Caddyfile.s2-log-snippet` as service-readable snippets at the paths below (or adjust the imports to their actual locations). Apply the baseline and redacted access logging to every public site block, including OpenList and redirects. Keep existing upstream, TLS, route and application-specific header settings; do not expose the static site on the raw server IP:

```caddyfile
import /etc/caddy/snippets/nkustudy-s2-headers
import /etc/caddy/snippets/nkustudy-s2-logs

www.nkustudy.top {
  import s2_security_headers
  import s2_access_log
  redir https://nkustudy.top{uri} permanent
}

nkustudy.top {
  import s2_security_headers
  import s2_access_log
  header {
    X-Frame-Options "DENY"
    Content-Security-Policy "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
  }
  # Existing API handlers and static root follow here.
}

pan.nkustudy.top {
  import s2_security_headers
  import s2_access_log
  # Retain the EXISTING OpenList reverse_proxy and all of its route settings here.
  # This is an integration example, not a complete replacement site block.
}

http://8.217.248.245 {
  respond 404
}
```

The shared logger retains `request.host`, so main, www and pan requests can be distinguished in the same private archive. Each site's query string and request/response headers are removed; only User-Agent is explicitly retained. Use the existing S2 archive timer for this shared log. Do not blindly apply the main site's CSP or frame restrictions to OpenList: verify its document/media previews first. Caddy's `rate_limit` is a non-standard module, so adding that directive to a stock binary is not a safe configuration-only change; retain Node's existing limits and plan any edge module separately.

Do not leave a second unfiltered `log { output stdout; format json }` access logger alongside `import s2_access_log`. Caddy sends each request to both loggers: the S2 file is redacted, but the other logger still includes query parameters, custom request headers and redirect response headers in journal output. Remove only that redundant site-level access-log block from main/www, keeping the S2 import and Caddy's normal process/runtime logging. If a separate access-log destination is required, apply the same filter to that destination as well. Do not delete historical logs as part of this configuration change.

Maintainer update received 2026-10-03 (the supplied receipt is dated 2026-10-02): pan and www now have baseline headers and the S2 import; independent public GET checks returned 200/301 with those headers. The supplied main/www configuration also contained the extra stdout access logger described above. Its disclosure was reproduced locally with synthetic values; removal and production readback remain pending. The receipt's archive and service-health statements are operator evidence, not an independent server inspection. Keep existing `includeSubDomains`, CSP and frame policy unless a separate reviewed change is needed.

Run `CADDY_BIN=/path/to/caddy node scripts/verify-s2-entry-log.mjs` locally before handing off. This exercises main, redirect and simulated OpenList responses, including downloads and errors; it does not attest to the production configuration. After the operator applies the imports, check real GET responses and read back one synthetic log entry per hostname, with a synthetic query/header secret, to confirm redaction and archive coverage. Follow the service-identity validation procedure in [S2 server acceptance](compliance/S2_SERVER_ACCEPTANCE.md); root validation can create root-owned log files and prevent startup.

Validate the Caddy configuration before reloading it. The host firewall should expose only 22, 80 and 443; use a rate-limited SSH rule and remove unused public ports. Do not disable password authentication or root login until a tested non-root sudo account and at least two working administrator public keys exist.

## Text-encoding integrity

All JSON transport is decoded as strict UTF-8. Public write requests containing the Unicode replacement character `U+FFFD` are rejected, and runtime-data migration rejects both malformed UTF-8 and existing replacement characters. Run `DATA_DIR=/var/lib/nkustudy/json npm run audit:encoding` before deployment and after bulk import. If it reports a finding, restore the exact field from a verified earlier source or ask the content owner; never guess the missing character or add a display-time substitution rule.

`PUBLIC_DIR` must be the `current` symlink beside `PUBLIC_RELEASES_DIR` in one service-owned publish directory. Publishing builds a fresh versioned directory and switches that inner symlink with a same-filesystem rename; it never deletes the live tree in place. A root-owned stable symlink keeps Caddy outside that writable boundary:

```text
/var/www/nkustudy-current -> /var/www/nkustudy-publish/current
/var/www/nkustudy-publish/                 nkustudy:nkustudy 0755
/var/www/nkustudy-publish/current           managed symlink
/var/www/nkustudy-publish/releases/         nkustudy:nkustudy 0755
```

Create the outer symlink once as root. The service account owns only `nkustudy-publish`, not `/var/www`. Seed `releases/` with the currently active static tree and point the inner `current` symlink at that seed before restarting the service. New published directories and files are explicitly normalized to `0755` and `0644`, so Caddy can read them even though the service uses `UMask=0077`. The publisher keeps the active release plus a bounded rollback history; it removes only strictly named managed releases and startup residue.

## One-time static topology migration

Run this in a maintenance window as root. Review every resolved path before copying or replacing links. The example uses the production environment file currently installed at `/etc/nkustudy-admin.env`; adjust the filename consistently if the unit uses a different one.

The command blocks below assume one continuous root shell: `deploy_stamp`, `backup_dir`, and later `candidate` are deliberately reused. If the shell is interrupted, do not guess them. Before each later block, set `backup_dir` to the exact reviewed backup directory, then run `deploy_stamp="$(cat "$backup_dir/deploy-stamp")"`; set `candidate="$(cat "$backup_dir/application-candidate")"` only after step 4 has created that file.

1. Stop writes, resolve the old target, verify space and device boundaries, and create root-only backups:

```bash
set -eu
systemctl stop nkustudy-admin.service
deploy_stamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="/root/nkustudy-backups/static-topology-${deploy_stamp}"
install -d -o root -g root -m 0700 "$backup_dir"
printf '%s\n' "$deploy_stamp" >"$backup_dir/deploy-stamp"

old_static_target="$(readlink -f /var/www/nkustudy-current)"
case "$old_static_target" in
  /var/www/.nkustudy-releases/release-*|/var/www/nkustudy-publish/releases/release-*) ;;
  *) echo "Unexpected active static target: $old_static_target" >&2; exit 1 ;;
esac
test -d "$old_static_target"
printf '%s\n' "$old_static_target" >"$backup_dir/old-static-target"
cp --preserve=mode,timestamps /etc/nkustudy-admin.env "$backup_dir/nkustudy-admin.env"
cp --preserve=mode,timestamps /etc/systemd/system/nkustudy-admin.service "$backup_dir/nkustudy-admin.service"
systemctl show --value -p WorkingDirectory nkustudy-admin.service >"$backup_dir/old-working-directory"
systemctl show --value -p ExecStart nkustudy-admin.service >"$backup_dir/old-exec-start"
if test -f /etc/systemd/system/nkustudy-admin.service.d/application-release.conf; then
  cp --preserve=mode,timestamps /etc/systemd/system/nkustudy-admin.service.d/application-release.conf "$backup_dir/application-release.conf"
else
  : >"$backup_dir/application-release.conf.absent"
fi
cp --preserve=mode,timestamps /var/lib/nkustudy/admin-secret "$backup_dir/admin-secret"
test ! -f /var/lib/nkustudy/backup-secrets.json || cp --preserve=mode,timestamps /var/lib/nkustudy/backup-secrets.json "$backup_dir/backup-secrets.json"
tar -C / -czf "$backup_dir/runtime-data.tar.gz" var/lib/nkustudy
tar -C / -czf "$backup_dir/static-release.tar.gz" "${old_static_target#/}"
chown -R root:root "$backup_dir"
find "$backup_dir" -type d -exec chmod 0700 {} +
find "$backup_dir" -type f -exec chmod 0600 {} +
(cd "$backup_dir" && find . -maxdepth 1 -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS)
chmod 0600 "$backup_dir/SHA256SUMS"

df -P /var/www /var/lib/nkustudy /opt/nkustudy-releases
test "$(stat -c %d /var/www)" = "$(stat -c %d /var/www/nkustudy-current)"
du -sh "$old_static_target" /var/lib/nkustudy
```

Stop if the backup fails, free space is insufficient, the active target is unexpected, or the link and its parent are on different devices. Copying `DATA_DIR` is a safety backup only; do not roll runtime data backward during an ordinary code/static rollback.

2. Seed the service-owned publish root without making `/var/www` writable:

```bash
set -eu
old_static_target="$(cat "$backup_dir/old-static-target")"
seed_release="$(basename "$old_static_target")"
printf '%s' "$seed_release" | grep -Eq '^release-[0-9]+-[a-f0-9]+$'

install -d -o nkustudy -g nkustudy -m 0755 /var/www/nkustudy-publish
install -d -o nkustudy -g nkustudy -m 0755 /var/www/nkustudy-publish/releases
test ! -e "/var/www/nkustudy-publish/releases/$seed_release"
cp -a --no-target-directory "$old_static_target" "/var/www/nkustudy-publish/releases/$seed_release"
chown -R nkustudy:nkustudy "/var/www/nkustudy-publish/releases/$seed_release"
find "/var/www/nkustudy-publish/releases/$seed_release" -type d -exec chmod 0755 {} +
find "/var/www/nkustudy-publish/releases/$seed_release" -type f -exec chmod 0644 {} +

runuser -u nkustudy -- ln -s "releases/$seed_release" /var/www/nkustudy-publish/current
ln -s /var/www/nkustudy-publish/current "/var/www/.nkustudy-current.next-$deploy_stamp"
mv -T "/var/www/.nkustudy-current.next-$deploy_stamp" /var/www/nkustudy-current

test "$(stat -c %U:%G /var/www/nkustudy-publish)" = "nkustudy:nkustudy"
test "$(stat -c %a /var/www/nkustudy-publish)" = "755"
test "$(readlink -f /var/www/nkustudy-current)" = "/var/www/nkustudy-publish/releases/$seed_release"
runuser -u nkustudy -- test -w /var/www/nkustudy-publish
! runuser -u nkustudy -- test -w /var/www
```

3. Update the environment file to the inner managed paths and install a systemd drop-in. `ReadWritePaths` must not contain `/var/www`:

```bash
set -eu
sed -i -E 's#^PUBLIC_DIR=.*#PUBLIC_DIR=/var/www/nkustudy-publish/current#' /etc/nkustudy-admin.env
sed -i -E 's#^PUBLIC_RELEASES_DIR=.*#PUBLIC_RELEASES_DIR=/var/www/nkustudy-publish/releases#' /etc/nkustudy-admin.env
grep -qx 'PUBLIC_DIR=/var/www/nkustudy-publish/current' /etc/nkustudy-admin.env
grep -qx 'PUBLIC_RELEASES_DIR=/var/www/nkustudy-publish/releases' /etc/nkustudy-admin.env

install -d -o root -g root -m 0755 /etc/systemd/system/nkustudy-admin.service.d
cat >/etc/systemd/system/nkustudy-admin.service.d/publish-paths.conf <<'EOF'
[Service]
ReadWritePaths=/var/lib/nkustudy /var/www/nkustudy-publish
EOF
chmod 0644 /etc/systemd/system/nkustudy-admin.service.d/publish-paths.conf
systemctl daemon-reload
systemctl cat nkustudy-admin.service
```

If either environment key is absent rather than replaced, stop and add it once; do not append duplicate keys blindly.

4. From the candidate code release, run checks, build, and one real static publish as `User=nkustudy` with the same environment file as the service:

```bash
candidate=/opt/nkustudy-releases/REVIEWED-CANDIDATE
test -d "$candidate"
printf '%s\n' "$candidate" >"$backup_dir/application-candidate"

systemd-run --quiet --wait --pipe --collect \
  -p User=nkustudy -p Group=nkustudy -p UMask=0077 \
  -p WorkingDirectory="$candidate" -p EnvironmentFile=/etc/nkustudy-admin.env \
  /usr/bin/npm run check:content
systemd-run --quiet --wait --pipe --collect \
  -p User=nkustudy -p Group=nkustudy -p UMask=0077 \
  -p WorkingDirectory="$candidate" -p EnvironmentFile=/etc/nkustudy-admin.env \
  /usr/bin/npm run build
systemd-run --quiet --wait --pipe --collect \
  -p User=nkustudy -p Group=nkustudy -p UMask=0077 \
  -p WorkingDirectory="$candidate" -p EnvironmentFile=/etc/nkustudy-admin.env \
  /usr/bin/node --input-type=module -e \
  'import path from "node:path"; import { StaticReleasePublisher } from "./server/static-release-publisher.mjs"; const publisher = new StaticReleasePublisher({ publicDir: process.env.PUBLIC_DIR, releaseRoot: process.env.PUBLIC_RELEASES_DIR, distDir: path.resolve("dist"), production: true }); await publisher.recoverStartup(); const result = await publisher.publish(async () => {}); console.log(JSON.stringify(result)); if (result.warnings?.length) process.exitCode = 2;'
```

A non-empty `warnings` array means the link switched but durability or cleanup degraded; keep the previous release and investigate before declaring the migration complete.

Only after all three candidate checks pass, atomically make the service use that same candidate. This drop-in resets `ExecStart` explicitly so both the working directory and executable source refer to one compatible application release; merely testing a candidate while restarting the old code is not a deployment.

```bash
set -eu
candidate="$(cat "$backup_dir/application-candidate")"
test -d "$candidate/server"
install -d -o root -g root -m 0755 /etc/systemd/system/nkustudy-admin.service.d
application_tmp="/etc/systemd/system/nkustudy-admin.service.d/.application-release.conf.next-$deploy_stamp"
cat >"$application_tmp" <<EOF
[Service]
WorkingDirectory=$candidate
ExecStart=
ExecStart=/usr/bin/node $candidate/server/admin-server.mjs
EOF
chown root:root "$application_tmp"
chmod 0644 "$application_tmp"
mv -T "$application_tmp" /etc/systemd/system/nkustudy-admin.service.d/application-release.conf
systemctl daemon-reload

test "$(systemctl show --value -p WorkingDirectory nkustudy-admin.service)" = "$candidate"
systemctl show --value -p ExecStart nkustudy-admin.service | grep -F -- "$candidate/server/admin-server.mjs"
systemctl cat nkustudy-admin.service
```

If production already has an atomically managed application pointer, it may be switched instead, but the two `systemctl show` checks remain mandatory and must resolve the effective `WorkingDirectory` and `ExecStart` to the reviewed candidate.

5. Start and verify the service, Caddy-visible files, management rebuild, legacy routes and public v1 routes:

```bash
systemctl restart nkustudy-admin.service
systemctl --no-pager --full status nkustudy-admin.service
runuser -u caddy -- test -r /var/www/nkustudy-current/index.html
curl -fsS https://nkustudy.top/api/v1/health
curl -fsS https://nkustudy.top/ >/dev/null
journalctl -u nkustudy-admin.service --since '-10 minutes' --no-pager
```

Perform one authenticated rebuild from the administration page and require a success response with no `warnings`. Do not put the administrator password in a command line. Keep the backup, seed release and old release tree until this check and the next planned restart both pass.

Rollback topology without rolling runtime data backward:

```bash
set -eu
systemctl stop nkustudy-admin.service
old_static_target="$(cat "$backup_dir/old-static-target")"
test -d "$old_static_target"
ln -s "$old_static_target" "/var/www/.nkustudy-current.rollback-$deploy_stamp"
mv -T "/var/www/.nkustudy-current.rollback-$deploy_stamp" /var/www/nkustudy-current
cp "$backup_dir/nkustudy-admin.env" /etc/nkustudy-admin.env
cp "$backup_dir/nkustudy-admin.service" /etc/systemd/system/nkustudy-admin.service
chown root:root /etc/nkustudy-admin.env /etc/systemd/system/nkustudy-admin.service
chmod 0600 /etc/nkustudy-admin.env
chmod 0644 /etc/systemd/system/nkustudy-admin.service
rm -f /etc/systemd/system/nkustudy-admin.service.d/publish-paths.conf
if test -f "$backup_dir/application-release.conf"; then
  cp "$backup_dir/application-release.conf" /etc/systemd/system/nkustudy-admin.service.d/application-release.conf
  chown root:root /etc/systemd/system/nkustudy-admin.service.d/application-release.conf
  chmod 0644 /etc/systemd/system/nkustudy-admin.service.d/application-release.conf
else
  test -f "$backup_dir/application-release.conf.absent"
  rm -f /etc/systemd/system/nkustudy-admin.service.d/application-release.conf
fi
systemctl daemon-reload
test "$(systemctl show --value -p WorkingDirectory nkustudy-admin.service)" = "$(cat "$backup_dir/old-working-directory")"
test "$(systemctl show --value -p ExecStart nkustudy-admin.service)" = "$(cat "$backup_dir/old-exec-start")"
systemctl restart nkustudy-admin.service
```

The application-release drop-in restoration is part of rollback: restoring only the static link while leaving the service on incompatible candidate code is not a valid rollback.

Only after an agreed stability period may the separately backed-up old static directories be removed. Do not delete `/var/lib/nkustudy` during topology cleanup.

## systemd example

```ini
[Service]
User=nkustudy
Group=nkustudy
WorkingDirectory=/opt/nkustudy/current
EnvironmentFile=/etc/nkustudy-admin.env
ExecStart=/usr/bin/node /opt/nkustudy/current/server/admin-server.mjs
Restart=on-failure
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ReadWritePaths=/var/lib/nkustudy /var/www/nkustudy-publish
```

Do not add `/var/www` to `ReadWritePaths` and do not make it writable by `nkustudy`. The code release still needs its build outputs (`dist`, `.astro`, and tool caches) writable for administrator-triggered rebuilds; source and package files do not need broad write permissions. Only one server process may write a `DATA_DIR` or publish root; the in-process queues are not a distributed lock.

`ProtectSystem` hardening and making the code release root-owned/read-only are valuable follow-up work, but are deliberately not part of this topology repair. They require a separate test of every Astro build/cache write path; do not enable them opportunistically during this migration.

## Runtime-data migration maintenance window

1. Make a verified root-only backup.
2. Stop the service and freeze website administration.
3. Run the plan-only `npm run migrate:runtime-data` command from `docs/data-schema.md` and save its JSON report.
4. Stop if course, review, or resource counts fall, if the unmatched-review list is unexpectedly large, or if any manual-fix item exists. Report the impact before proceeding; do not hide it with compatibility code.
5. Apply only with the plan SHA, a new root-only backup directory, and exact reviewed confirmation counts. The command refuses to overwrite an existing target.
6. Point `DATA_DIR` at the migrated target, then run tests/content validation/build and start one service process.

Before exposing the mini program, proxy only `/api/v1/*` to `127.0.0.1:8787`; do not map `/admin-api/*` beneath that prefix. Verify the exact public route list in `docs/public-api.md`, and configure the WeChat request/download legal domains listed there.

## Release gate

Run `npm ci`, `npm test`, `npm run check`, `npm run check:fixtures`, `npm run build:fixtures`, then run the production-data checks with an explicit path: `DATA_DIR=/var/lib/nkustudy/json npm run check:content`, `DATA_DIR=/var/lib/nkustudy/json npm run check`, and `DATA_DIR=/var/lib/nkustudy/json npm run build`. Record the existing Astro diagnostic baseline, but reject every newly introduced diagnostic. Run `npm run smoke:public-api`, then continue with the legacy website/API regression suite. Dependency audit is an online deployment gate and must be run in the connected release environment. A fixture build is disposable and must never be copied to the server.

Switch both application and static release pointers only after backups and candidate checks pass. On failure, restore the previous pointers and restart. Runtime data is restored only after separately proving data corruption; normal code rollback must not roll data backward.

## Manifest publish recovery

Before every manifest draft or publish, the server writes and fsyncs a mode-0600 snapshot under `${DATA_DIR}/.manifest-backups/`. The newest 20 snapshots are retained. Every manifest and static-content replacement also records a mode-0600 snapshot and durable journal under `${DATA_DIR}/.publish-snapshots/` and `${DATA_DIR}/.publish-journal/`; both directories are mode `0700`. A handled build failure restores the prior JSON in the same per-file queue and removes its journal. Startup recovery runs before the HTTP listener is created. It removes strictly named incomplete static build directories and temporary `current` links, then validates that the inner `current` link points to a managed release. Journal recovery safely removes a journal only when the JSON is still at its previous revision, or when a durably published journal matches its recorded next revision. An ambiguous crash after JSON replacement fails startup closed with `PUBLISH_RECOVERY_REQUIRED`; reconcile the named JSON against its snapshot and active `/var/www/nkustudy-publish/current` release before removing the journal. Do not delete these artifacts blindly.

All administrator full-manifest, R2 synchronization and static-content writes use revision CAS. HTTP 409 means nothing was overwritten: reload, inspect the other edit, then retry. Legacy R2 delete/move endpoints intentionally return 410. A dedicated in-process R2 queue serializes revision read, planning, collision checks, copy/verification, manifest CAS publish, and exact cleanup recording. Raw object keys remain opaque during deletion; no normalizer is allowed in cleanup. The safe route copies and verifies exact destination keys, publishes the CAS-protected manifest, and only then deletes the exact authorized old keys. Cleanup prefixes/keys that equal, contain, or sit beneath a copy target are rejected before copying. Cleanup failures leave harmless unreferenced objects for later removal.


## S2 日志与完整备份（2026-10-03收尾更新）

本地修复、真实Caddy隔离验证、WAL/JSON恢复结果见 [S2验收报告](compliance/S2_ACCEPTANCE.md)。发布前及生产回执按 [S2服务器操作单](compliance/S2_SERVER_ACCEPTANCE.md) 逐项执行，不能用旧的“JSON备份已上传”代替完整恢复验证。

S2完整备份必须加密，包含账号、运行JSON、日志和必要配置；公开资源桶不再接收私密备份或审计。新增配置路径`BACKUP_ENV_FILE/BACKUP_CADDY_FILE/BACKUP_SERVICE_FILE`须对应实际systemd/Caddy文件，独立私密桶使用`BACKUP_R2_BUCKET`并由维护者完成权限核验。恢复工具只创建隔离目录，D-01与恢复后删除状态核对完成前不能直接切换为生产。

维护者回执中的477b191已上线，这是20261001-s2的历史回执；2026-10-02新增的备份凭据隔离与设置口令修复已提交为49507d9，未部署。当前收尾的新包还包含其后的运行告警、只读备份预检及指南冒烟修复，**部署候选必须以新包`RELEASE.json`中的完整提交编号为准**。477b191旧包和49507d9前置提交不代表这份新包；先核对包内`SHA256SUMS`，Git检出时核对候选目录的`git rev-parse HEAD`，其他接收方式按新包README核对版本，再按操作单复跑。原254/254、后续260/260及296/296分别对应不同历史采样；本轮后台选项的保存、刷新回填及取消编辑已通过主窗口合成浏览器验收，证据见S2验收报告。代码固定版本以本次随附`RELEASE.json`为准，包校验以随附`verification/package-integrity.json`为准。

新备份客户端要求以下独立配置（值由维护者通过受控环境文件提供）：

```ini
BACKUP_R2_BUCKET=nkustudy-private-backups
BACKUP_R2_ACCOUNT_ID=<32位Account ID>
BACKUP_R2_ACCESS_KEY_ID=<备份专用Access Key ID>
BACKUP_R2_SECRET_ACCESS_KEY=<备份专用Secret Access Key>
BACKUP_R2_PRIVATE_CONFIRMED=1
```

最后一项只能在核验私密权限后设置，具体检查见服务器操作单。客户端使用标准`https://<Account ID>.r2.cloudflarestorage.com`端点；缺少专用凭据时拒绝远端备份并保留已完成的本地副本，不使用资源凭据兜底。现有`R2_*`资源配置继续供课程及头像访问，不能替换成仅限备份桶的令牌。

477b191曾把输入口令重复保存到普通备份设置中，认证后的设置接口可能回传明文。部署新包修复后，接口读取即隐藏旧副本；再正常保存一次备份设置（密码留空、开关保持原值）清理普通设置中的重复字段，并确认私密文件中的现有口令未变。已有加密备份和旧口令继续保留；不要为了此次清理直接轮换。私密桶、真实PUT/GET校验、匿名拒绝及保留设置仍待后续生产回执，本地合成测试不代替这些检查。

基于49507d9的后续并行工作增加只读`node scripts/s2-backup-preflight.mjs`和通知机器人`ops`用途。预检由服务账号使用服务环境运行，静态检查不通过时非零退出；退出0也不证明远端权限、恢复或通知送达。现有待审/日报配置不会自动订阅运行告警；后续获授权启用时，须在后台明确勾选“运行告警”。告警去重/重试在进程内维护，停机、Caddy和容量故障仍靠外部监控。

按2026-10-03用户决定C-11，当前仅收尾S2这一批，真实通知本轮暂缓：不重新接通、不新增真实运行告警订阅、不发送测试，也不把它列为本批提交/打包的阻塞项。用户表示通知服务以前接通过，这一历史反馈不能证明新`ops`用途已经生产投递验收。私密R2、外部监控、用户口令保管/独立解密、仍有1973条错误的类型检查、D-01及新包生产部署继续如实留待后续；S3/S4/S5未启动。当前阶段的实测和交付状态以S2验收报告的最新记录为准。

## S3 迁移预览与后续上线关卡（2026-10-07）

本节按2026-10-06用户决定及2026-10-07本批收尾授权更新当前候选的操作要求，保留上面的历史回执。S3核心历史提交为`98304954038735b8e437a43ea2a84f3b48816c94`；本批收尾更新草稿PR #3，固定候选以随包`RELEASE.json`及校验清单为准，不合并、不部署。维护者明确报告S3未部署；已有生产回执仍为`main 8ddcdc5`、维护者发布号`20261004-pr2`，依据见[S2最新生产回执](compliance/S2_SERVER_ACCEPTANCE.md)。**朋友当前只需用新候选做一次只读预览对照；下面的上线步骤须另行获得部署授权后执行。**

用户已决定：历史已公开内容保持公开，不重新审核或撤下；新投稿使用S3规则。历史已公开评价继续由`legacy_visibility_import`保留可见性。对尚未迁移的v1反馈，仅旧公开接口实际可见的普通反馈（原始`status`精确为`approved`/`completed`，未隐藏、未私密、无举报来源且无显式`publicationBlocked`）导入既有公开资格；已有公开回复保持公开，回复文本与既有时间原样保留，不补造缺失时间。反馈独立记录`legacyVisibilitySource=legacy_feedback_visibility_import`及`legacyVisibilityImportedAt`，初始`decisionSource=legacy_feedback_visibility_import`，不生成历史`reviewedBy/reviewedAt`；迁移时间是导入来源记录，不是当时人工审批。原文、ID、隐藏与私密边界保留，旧未公开、私密或举报条目不因此公开。

已经标记schema v2的条目不再根据旧`status`或`handlingStatus`补公开资格；原v2 `publicationBlocked`数据不会自动解封，管理PATCH也不接受解除block或改私密来源。如果实际输入已被旧候选迁移，应停止并单独核对原始备份与状态，不能通过改版本、改状态或直接覆盖数据套用本次v1导入。

新普通反馈仍需认证、服务端受理为待批准公开，管理员须显式作公开决定；处理完成、回复、取消隐藏都不授予新的公开资格。新评价保留原有`moderationRequired`及已启用关键词规则：需人工或命中规则时待审，否则自动公开，并记录真实规则快照及来源。后续隐藏、拒绝、撤销仍决定最新可见性；修改旧公开回复仍默认仅提交者可见，只有显式选择公开且条目公共gate通过才公开。已知投诉举报永久私密。真实通知继续暂缓，本批不启用私密R2，不做S4；批量处置、合并和条目删除仍未实现。

### 维护者第一步：只读预览

历史采样：2026-10-05启动坏结构保护与预览脱敏补丁后，`TMPDIR=/private/tmp npm test`为386/386，API文档130条一致、夹具检查通过、14页夹具构建通过；下文354/354为更早S3核心采样。这些结果不能作为10-07新候选的通过数字，新候选的完整复跑结果以[S3计划及逐项证据](compliance/plans/s3-20261004.json)为准。旧类型检查仍有1691条历史错误，生产/手机未执行项继续保留。

2026-10-07当前候选本地检查：`npm ci`首次下载遇`ECONNRESET`，重试成功；`TMPDIR=/private/tmp npm test`为396/396，0失败、0跳过，API文档130条一致、夹具检查及14页夹具构建通过；`npm audit`完整依赖及`--omit=dev`均0告警。新增依赖边界合成验证3/3通过，覆盖source-map非法offset拒绝与正常映射、Astro远程图片TTL/304/no-store；独立依赖复核未发现阻塞。`cache` 4.3上游`max-stale`语义仍有争议，不宣称已修复；magicast内联旧source-map残留仅位于`astro add`路径，本轮未改。上述结果是本地源码候选证据，不能代替固定交付包在Linux的复跑或生产回执。

本轮浏览器操作被自动审批拒绝（网络流断开），新浏览器验收尚未执行，待用户允许重试；此前浏览器证据保留为历史证据，不计入本轮通过。新生产只读预览、S3上线及手机验收也未完成，不因本地396项测试或依赖复核通过而改写状态。

已留存的生产只读回执显示：反馈共8条均已公开（`approved` 4条、`completed` 4条），评价1477条已公开。旧候选预览将8条反馈全部blocked、公开数为0，是已被新决策替代的历史行为证据，不能复用为新候选验收。朋友无需逐条重新审原文；先对照同一源文件的新预览即可。下表的新候选公开数是**同字节输入下的验收预期，尚不是一次新生产预览或部署结果**：

| 文件 | 原回执`sourceSha256` | 原公开数 | 新候选预期`publicEligible` |
| --- | --- | --- | --- |
| feedback.json | `4f1269070b2736adad9eee48b50200972716822c3ca8fd958fb1c2e76510dec4` | 8 | 8 |
| reviews.json | `2fb00961933c761087f2003900de3c0891d097d83f68fca6ce6a579e274942a8` | 1477 | 1477 |

若当前源哈希变化，以新只读预览和当前真实公开数量重新对照，不沿用旧计数。若相同输入出现公开数下降、旧公开回复丢失或被改为仅提交者可见，保留证据并停止，不能要求朋友重审历史原文来适配候选缺陷。

候选源码必须解压到新建的独立目录，与当前应用、静态公开目录及运行数据目录分开。先核对源码包校验和固定版本；当前步骤不启动候选服务、不执行生产`npm run build`、不覆盖或修正任何原始data。预览只依赖Node内置模块，无需先安装npm依赖；不得以导入`server/admin-server.mjs`代替预览，那会触发初始化和迁移。

由维护者私下查看实际生效的systemd unit、drop-in及其环境文件，定位**确切的`DATA_DIR`绝对路径**，同时确认实际`User`、`Group`、Node可执行文件和候选目录读取权限。上文`/var/lib/nkustudy/json`及`nkustudy`只是历史示例，不能据此猜当前路径或身份；不要把环境文件、完整`systemctl cat/show`输出或秘密值发到聊天。数据根目录须为实际非符号链接目录，两份JSON须为非符号链接常规文件；缺文件时预览失败，不会创建默认文件。预览使用实际服务身份读取两份JSON，保持原有权限；若无读取权限就停止，不能为了预览把数据改为公开可读。

下面由维护者在具备`runuser`权限的受控shell中执行；先将所有占位符替换为已核对的实际值。回执目录须是发布目录、公开目录和`DATA_DIR`之外的新私密目录；它只保存预览输出，不是数据备份。

```bash
set -eu
candidate='/绝对路径/独立的S3候选源码目录'
node_bin='/绝对路径/现有Node可执行文件'
service_user='实际服务User'
service_group='实际服务Group'
actual_data_dir='/从现有生效配置确认的实际DATA_DIR'
preview_log_dir='/绝对路径/新建的私密预览回执目录'

umask 077
test ! -e "$preview_log_dir"
test ! -L "$preview_log_dir"
install -d -m 0700 "$preview_log_dir"
if runuser -u "$service_user" -g "$service_group" -- "$node_bin" \
  "$candidate/scripts/preview-moderation-migration.mjs" --data-dir "$actual_data_dir" \
  >"$preview_log_dir/stdout.json" 2>"$preview_log_dir/stderr.txt"; then
  preview_status=0
else
  preview_status=$?
fi
printf '%s\n' "$preview_status" >"$preview_log_dir/exit-code.txt"
chmod 0600 "$preview_log_dir/stdout.json" "$preview_log_dir/stderr.txt" "$preview_log_dir/exit-code.txt"
```

退出0仅表示此次两份输入均可只读预览，stdout为统计JSON；非0退出时停止后续步骤，保留原文件并调查原因。新版脚本失败时stdout为空、stderr为固定错误码JSON，但**stdout、stderr及外层shell错误仍须私下检查后再转发**，不能假设任意候选版本或系统错误都没有路径、标识符或原文。遇到非法JSON、UTF-8、数据结构、重复ID或不支持的版本，不得自动清空数组、用默认文档替换历史数据或继续部署。

仅回传退出码、候选固定版本，以及`files.feedback`/`files.reviews`各自的`sourceSha256`和以下统计：`total`、`private`、`publicationBlocked`、`publicEligible`、`importedLegacyVisibility`、`pending`、`alreadyMigrated`。`importedLegacyVisibility`统计当前`decisionSource`为评价旧导入或反馈新导入来源的条目。反馈另回传`legacyPublicBefore`、`legacyPublicPreserved`、`legacyPublicRepliesBefore`、`legacyPublicRepliesPreserved`：前两项分别是v1旧公开数量与迁移后仍公开且标题/正文/回复/既有回复时间原样匹配的数量；后两项分别是其中已有非空字符串回复的数量与回复仍原样且`replyVisibility=public`的数量。对本次v1输入，两组before/preserved应分别相等；schema v2输入的四项为0不表示历史内容被撤下，应查看`publicEligible`及`alreadyMigrated`，不能据此重新导入v2条目。

这些统计可重叠，不能相加当作总量；`private:false`不等于允许公开。维护者在服务器私下核对总量、原文/ID保留及分类影响，异常时保留原始证据并停止。只回传数量不回传原文、条目/账号ID、联系方式、回复、举报链接及完整运行JSON。

`sourceSha256`对应本次读取的**原始文件字节**，用于后续复核输入是否变化。`previewSha256`只对应以本次`generatedAt`模拟规范化后的compact JSON；时间和实际启动序列会影响结果，它不是启动后文件的字节哈希、内容revision或可用于apply的计划锁。`alreadyMigrated:true`表示输入已有v2标记且此次补默认设置、规范化后语义无需变化，不是一次生产迁移成功回执。预览不写源文件字节或mtime，系统读取仍可能更新atime；它不锁写入者，也不提供feedback/reviews共同时间点的快照。预览不检查完整生产配置、SQLite一致性、CDN、备份恢复、通知或R2权限；目前没有SOURCE_CHANGED竞态专项注入证据，不能把变化检测当作冻结保障。

可直接转发朋友的首步指令：

> 请把本批新S3候选源码解压到新的独立目录并核对固定版本；从现有生效的systemd配置私下确认真实DATA_DIR、服务User/Group及Node路径，保持原权限。旧服务继续运行，暂不启动候选、不做生产构建或覆盖data。仅运行候选的`node scripts/preview-moderation-migration.mjs --data-dir <真实绝对路径>`，stdout/stderr私密留存并检查脱敏后，只回传两文件统计、sourceSha256、固定版本及退出码，包括反馈新增的两组公开内容/回复before与preserved计数。若仍是原回执的同一源哈希，新预览应保留8条公开反馈及1477条公开评价，两组before/preserved分别相等；不需要重审历史原文。源哈希变化就按新统计对照；非法数据、非0退出或可见性意外下降均停止。本步骤不会部署S3。

### 获授权后逐项满足上线关卡

1. **先在隔离环境复跑固定候选。** 核对随包`RELEASE.json`及校验清单，按锁文件安装依赖，运行测试、API文档检查、内容检查与fixture构建，并在联网交付环境复跑依赖审计；fixture只用于验收，不能发布。保留Linux实际结果及类型诊断差异。10-07本地完整复跑为上文396/396，354/354和386/386仅为历史采样，最终交付包仍须复跑；默认macOS TMPDIR曾350/354，4个静态发布失败在旧HEAD也复现，不能写成默认命令全绿。已记录的旧类型检查仍1691个历史错误、exit 1；当时归一后的新增诊断为0、减少280，不代表类型检查通过或10-07重新验证了类型诊断。详细边界见[S3计划及逐项证据](compliance/plans/s3-20261004.json)。

2. **维护窗口冻结全部写入，并做原始私密备份。** 先安排入口维护措施，再停止旧Node服务及其他会写运行JSON/SQLite的进程或任务，确认没有自动重启、第二实例或离线写入者；一致性保障依赖单写进程及运维停写，不存在可直接调用的S3维护锁。记录实际服务身份、有效`WorkingDirectory`/`ExecStart`及旧应用/静态指针。以现有受控备份流程保留迁移前的原始JSON、SQLite及所需秘密/配置；不能只复制活动SQLite主文件而遗漏WAL，停写复制或SQLite备份接口须形成一致快照。备份留在私密目录（目录0700、文件0600；原文和秘密按既有流程加密保管），校验并确认可隔离恢复，不上传公开桶、不接通私密R2、不删除历史队列/快照/journal。备份失败或空间不足时停止。

3. **停旧进程后复核同一候选、同一输入。** 在仍停写的状态再次运行只读预览，对照两个`sourceSha256`与已审阅的影响统计，并确认历史已公开内容及公开回复仍保留；备份中的原始两文件也须与这次源字节哈希对应。旧候选的8条blocked预览不能替代此次复核。旧服务运行期间的预览不是冻结快照，任一source hash变化都必须重新预览、核对影响并更新备份，不能沿用旧结果。当前没有独立S3 apply CLI、`expectedPlanHash`检查或预览到启动的锁；维护者须保持停写边界直至候选接管，不能把`npm run migrate:runtime-data`的另一套迁移协议当作S3 apply。

4. **在维护状态切换候选，按真实启动顺序验收。** 核对服务User/Group、运行路径、sentinel、0700/0600、数据库父目录及发布目录权限；以实际服务身份使用实际环境，不用root测试代替服务权限验证。确认有效`WorkingDirectory`与`ExecStart`均指向已复跑的完整候选后，只启动一个候选进程。生产路径预检先于SQLite或可变文件创建；随后服务会初始化其状态组件，依次恢复静态发布、manifest journal、content journal，初始化/校验运行数据，再分别持久化`feedback.json`和`reviews.json`的v2规范化，最后才创建HTTP服务并监听。**两个迁移写入不是跨文件事务；启动失败可能已改写其中一份JSON。** 遇`PUBLISH_RECOVERY_REQUIRED`或迁移错误保持维护状态，按命名快照、journal及活跃静态发布核对，不删除恢复证据，也不反复切回旧进程尝试“自动修好”。

5. **发布新静态产物并清理旧缓存后才开放入口。** 自动启动迁移不会重建静态站点；维护状态下从同一候选、使用实际受控`DATA_DIR`完成生产内容检查、构建及受管理的静态发布，确认没有warnings、Caddy可读且活跃指针正确。核对现存自定义公告与实际自动公开规则一致；新默认公告不会覆盖旧自定义内容。清除CDN中旧UGC接口及受影响页面/搜索数据缓存，调整缓存规则使含评价派生内容的home/courses/review-groups/search-index/search-data和旧公开列表遵守`no-store`。从实际入口用新浏览器会话，并携带历史ETag请求，核验这些接口不再返回旧304/正文；核对旧公开目录不会绕过当前指针继续暴露。新响应头和本机测试不能召回已留在浏览器或第三方的旧副本，生产缓存清理必须另留回执。

6. **用最少合成数据核验，再清理自验影响并回执。** 合成投稿也可能触发现有自动通知，先只读核对现有目标不会实际投递；若不能保证，后续获部署授权时也不做生产写入自验，改在隔离合成环境验证并明确记录生产链路未执行，不能只因没有点击通知“测试”按钮就声称未发送。不发送真实通知，不开私密R2。具备上述边界后，通过现有认证入口，以合成账号/内容验证投稿→后台单条处理/回复→刷新/重启读回，核对新普通反馈待批准、原有评价自动规则、冲突409、私密投诉始终不进入公开列表，以及公开反馈/评价隐藏或撤销后下一请求的列表、搜索和派生统计均无该内容。历史公开保留不允许新条目通过旧status、完成处理或回复绕过公开决定。先登记自验所建账号/条目，结束后用受支持的单条处置隐藏并撤销合成公开内容，清空合成回复，核对公开出口及缓存已无自验标记；按现有账号流程关闭临时管理员或撤销合成用户凭据，保留必要审计，不直接改JSON/SQL抹去记录。本批没有条目删除、批量处置或合并接口。真实微信链路、实际手机键盘/390与320宽度联调等未执行项继续单列，不能用桌面浏览器或历史自动测试采样代替。

回执只含固定提交/实际发布号、Node版本、测试与未完成项、两文件迁移前source hash/影响计数、备份及隔离恢复结论、单进程/权限结论、新静态发布和实际入口缓存结果、合成自验及清理结论；不附原始数据、密钥或完整日志。通知写“用户暂缓，未发送”，私密R2写“本批未启用”，真机未跑就写“未执行”。原始私密备份保留至另行约定的稳定期。

### S3 数据兼容回退

上文普通代码/静态回退流程不能直接套到已迁移的S3数据：S2的旧公开gate不认识v2的`publicationBlocked`、批准依据和处理/公开分离，简单切回`8ddcdc5`或旧静态产物可能重新公开应受限内容。迁移后故障先保持维护状态、停止所有写入并留存失败时新数据、SQLite及journal；优先使用兼容schema v2且保留同一公开gate的修复/回退版本。若确需恢复迁移前完整备份，须单独评估停写后新增内容、账号及删除状态的取舍，验证隔离恢复并同步核对应用、静态产物、运行数据和缓存后再开放；不能只回退两份JSON、把正常代码回退当作可自动倒退运行数据的授权，或绕过S2恢复隔离标志。

## S6 OPS-20 本机部署准备度（2026-10-07）

`node scripts/check-deployment-readiness.mjs` 是只读检查器；新增工具和本地合成测试不代表已授权部署、读取生产个人资料、重启服务或执行生产写入自验。首次启用 S5 的独立注销账本仍按 [S5 操作单](compliance/S5_OPERATIONS.md) 在停写维护窗口执行，检查器不会初始化账本。生产候选须固定完整提交、保持 S3/S4/S5 的数据与回退兼容边界。

### 本机静态配置

在固定候选中，以计划运行候选的服务身份、使用已核准的实际环境运行。程序不加载或 `source` 环境文件，不自行改权限、创建目录、建表、重放队列、启动服务、写日志、制作备份或解除恢复隔离。检查器复用 `runtime-config` 的生产路径/启动预检、`backup-preflight` 的备份秘密隔离和目的地选择、`trustedProxyRules` 的代理规则、`StaticReleasePublisher.readDeploymentProof()` 的发布拓扑，以及 S5 的绑定和账本链校验；不会另设一套备份或恢复规范。

现有生产变量包括 `NODE_ENV=production`、`DATA_DIR`、`STATE_DB_PATH`、`ADMIN_SECRET_FILE`、`ADMIN_ORIGIN`、`PUBLIC_RESOURCE_ORIGIN`、`TRUSTED_PROXIES`、`PUBLIC_DIR`、`PUBLIC_RELEASES_DIR`、`DELETION_LEDGER_DIR`，以及现有备份配置。检查器要求既有 SQLite、日志表、日志 queue/归档目录、访问日志文件和有效静态发布已经存在；全新空环境不会被当作部署准备完毕。所有路径必须私下核对，口令、token、原始配置和个人数据不要放进参数或回传材料。

另外三个变量仅向检查器明确操作者选择的实际位置/预算，不替服务、Caddy 或 timer 配置它们：

| 检查变量 | 对应既有操作配置 | 检查范围 |
|---|---|---|
| `S2_ACCESS_LOG` | Caddy S2 snippet 的 `{$S2_ACCESS_LOG:/var/log/nkustudy/access.jsonl}` 实际展开后的现存文件 | 必须明确绝对路径，检查可读、私密、常规非链接文件；不读日志内容。程序不会把 snippet 的默认值当作实际生效证明 |
| `ENTRY_LOG_ARCHIVE_DIR` | 既有 `archive-entry-logs.mjs <CADDY-LOG-DIR> <PRIVATE-ARCHIVE-DIR>` 的第二参数 | 必须已存在、私密且当前身份可写，与入口日志源目录分离并位于公开树之外；不执行归档或 timer |
| `DEPLOYMENT_MIN_FREE_BYTES` | 操作者结合现有保留窗口、每日增长、备份/构建临时空间制定的正整数剩余空间预算 | 对运行数据、SQLite、静态发布、入口归档和账本所在文件系统分别检查。不是默认保留天数，也不能替代增长预测或磁盘告警 |

```sh
node scripts/check-deployment-readiness.mjs
```

输出只含固定检查 ID、状态和错误码。缺关键变量、日志表/事件唯一索引、归档写权限、静态发布、独立且已绑定的注销账本，或存在 `.restore-quarantine`，都会使 `localStaticReady:false`。缺配置不会由开发环境默认值补成通过。非空日志 JSON 队列只报告待恢复失败，不读队列原文、不重放；既有 [S2 存储健康工具](compliance/S2_SERVER_ACCEPTANCE.md) 和日志故障恢复流程仍负责内容校验与恢复。检查器通过仅说明检查当时的文件/配置及 schema 条件满足，不证明可 fsync、事务写入成功、留存完整、全部注销作业完成或进程已经使用这些配置。

SQLite 用 `readonly`、`query_only` 和读事务检查完整性、固定日志 schema、注销绑定及作业 schema，不查询/导出业务用户或日志行。已有在线 WAL/SHM 可被查询；SQLite 读锁可能触碰现有 SHM 锁元数据，这不是业务数据写入。WAL 库缺 WAL 或 SHM 时返回 `DATABASE_WAL_SIDECARS_REQUIRED/pending` 并且不开库，防止读连接替它创建文件。不能删除 WAL/SHM、用忽略 WAL 的 `immutable` 读取来“让检查通过”，也不能拿未经核准的主文件复制当一致快照。维护窗口中的隔离一致快照可用于 schema 复核，但须另列它与正在运行服务的差异；检查器不转换 journal mode。文件读取可能更新 atime；这次检查既不冻结写入者，也不是跨文件一致性快照。

POSIX 模式和 `access` 仅针对当前身份；Windows ACL、未知平台、不可用的容量接口以及依赖未能检查的项目会保持 `pending`，不算静态通过。Caddy 与归档 timer 若用不同身份，当前身份读/写失败不能用 root 重跑后的通过掩盖，应分别由相应受控身份核对并在人工回执说明。工具本身无法证明 systemd 有效环境、实际 service User/Group、单写进程、上游代理拓扑或实际 Caddy 日志展开值。

### 显式合成 HTTP 探针及日志验证

默认命令没有 HTTP、云端或通知访问。仅在已确认目标是隔离合成服务时可添加独立参数；该参数是操作者对合成来源的断言，localhost 本身不证明没有接生产数据：

```sh
node scripts/check-deployment-readiness.mjs \
  --synthetic-localhost-origin=http://127.0.0.1:8787
```

允许的 origin 仅为有显式端口的 `http://127.0.0.1:<PORT>` 或 `http://[::1]:<PORT>`；不支持 DNS 名称、真实站点、HTTPS、凭据、路径、query 或 fragment。程序不读取浏览器 Cookie，不携带认证、不跟随重定向；每个 GET 有 3 秒整体超时和 8 KiB 响应上限。只访问 `/api/v1/health` 与未登录的 `/api/v1/me`，核对 `no-store`、`nosniff`、健康状态、已配置的注销能力/零 pending，以及未登录拒绝；不输出正文、origin、ledger 水位或标识。这里的 `syntheticReady:true` 只对应这两个 GET，不能证明用户/管理员日志成功写入、HTTPS、安全头、CDN 缓存或真实注销链路。

日志写入/故障/重放/归档和备份恢复仍用真实已有模块在临时合成目录做定向测试，避免只读检查器向待部署环境插入探针。OPS-20 合成检查覆盖故意缺日志表、缺事件列/唯一索引、只读归档/queue、缺日志配置、恢复隔离、缺账本/错谱系及 WAL 边界；操作者纠正测试夹具后重新核对通过，检查器从未自动修复。

```sh
node --test test/deployment-readiness.test.mjs test/backup-preflight.test.mjs \
  test/runtime-config.test.mjs test/s2-durability.test.mjs test/s5-deletion-ledger.test.mjs
```

### 结果与生产回执边界

| 字段或退出码 | 含义 |
|---|---|
| `localStaticReady` | 本次所有静态必需检查通过；显式关闭的远端目的地可以跳过，关闭不是远端验收 |
| `syntheticRequested:false`、`syntheticReady:null` | 未运行 HTTP 探针；对应检查保持 `pending` |
| `syntheticRequested:true`、`syntheticReady` | 显式合成 GET 探针结果，独立于静态配置结果 |
| `localChecksPassed` | 静态通过且所有请求执行的合成 GET 通过 |
| exit `0` | 仅 `localChecksPassed:true`；生产仍待验 |
| exit `1` | 本次要求的本机静态/合成检查失败或仍无法验证；不能继续声称本机检查通过 |
| exit `2` | 不支持/重复参数；不会回显输入 |
| `productionStatus:pending`、`productionReady:false`、`ops20Accepted:false` | 工具始终保留生产验收边界，不导入人工“已通过”开关来消除待验项 |

后续另获生产授权后，维护者按 [S2 服务器验收](compliance/S2_SERVER_ACCEPTANCE.md)、S3/S4 交付说明及 [S5 操作单](compliance/S5_OPERATIONS.md) 留受控脱敏回执：实际服务身份/环境与单写进程、HTTPS/入口安全头/防火墙、可信代理及真实源端口解释、私密及派生公开内容缓存/CDN、实际 Caddy 脱敏样本/保留配置/归档 timer、日志持久化与恢复、增长容量/外部监控、一致加密备份及隔离恢复、最新权威注销头和历史覆盖/作业/远端清理。只回传固定版本、状态、计数和固定码，真实原件保留在受控位置。生产告知/隐私页、自定义文案、真机和人工交付验收仍独立留待。

本轮仍遵守用户暂缓边界：真实通知不接通、不启用、不发测试；私密 R2 不启用、不发 PUT/GET。静态关闭目的地、历史通知反馈、本机 HTTP 成功或日志测试通过均不能关闭这些生产待验项。当前 S6 的定向合成证据见 [deployment 证据摘要](compliance/evidence/S6-local-20261007/deployment/summary.json)。

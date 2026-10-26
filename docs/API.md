# NKUStudy 接口文档

本文档以当前仓库中的 `server/public-api-router.mjs`、`server/admin-server.mjs`、服务层、DTO 和网页调用代码为准，面向小程序、网站前端和后台维护人员。

2026-10-07 文档按 S3/S4/S5 当前源码核对；这些候选尚未部署生产，下述契约不能作为生产已生效的回执。当前本地、浏览器和未验范围分别见[整改台账](compliance/SECURITY_ASSESSMENT_READINESS.md)、[S4 验收](compliance/S4_ACCEPTANCE.md)和[S5 验收](compliance/S5_ACCEPTANCE.md)。固定候选以提交及随包 `RELEASE.json`、校验清单为准；部署边界与只读预览见[部署说明](DEPLOYMENT.md)。测试数量及类型检查状态保留在各次证据中，不在此维护另一份发布状态表。

- 生产站点基址：`https://nkustudy.top`
- 小程序公共 API 基址：`https://nkustudy.top/api/v1`
- 资源下载域名：`https://resources.nkustudy.top`
- 接口范围以以下路由总表为准；`npm run check:api-docs` 会核对总表与源码并输出当前 method/path 数量，避免维护第二份容易过期的统计。其中 3 个旧 R2 管理接口已禁用并固定返回 `410 Gone`。

## 接口总表

“公开”表示无需登录；管理接口的“Cookie”指登录所得 `__Host-nkustudy_admin`。用户接口的“登录”可使用 Bearer 或 `nkustudy_web_session` Cookie；显式 Authorization 优先，无效 Bearer 不回退 Cookie。退出接口不要求当前 Cookie 有效。

<!-- api-route-registry:start -->
| 方法 | 路径 | 权限 | 用途 |
| --- | --- | --- | --- |
| `GET` | `/api/v1/health` | 公开 | 运行时数据健康检查 |
| `GET` | `/api/v1/home` | 公开 | 小程序首页数据 |
| `POST` | `/api/v1/community-support/downloads` | account 必须 Bearer；community 不带 Authorization | 幂等记录公开资源下载完成事件，默认关闭 |
| `GET` | `/api/v1/me/community-support` | 仅 Bearer | 本人有效花币统计，默认关闭 |
| `GET` | `/api/v1/search-index` | 公开 | 完整、版本化的四类搜索快照 |
| `GET` | `/api/v1/catalog` | 公开 | 选课手册课程目录（课程+教师，支持 q 搜索与分页） |
| `GET` | `/api/v1/search-data` | 公开、no-store | 前端本地搜索精简数据（课程库/目录池/评价组名称与老师） |
| `GET` | `/api/v1/about` | 公开、ETag 缓存 | 关于页内容（标题+markdown 正文，与网页关于页同源） |
| `GET` | `/api/v1/donate` | 公开、ETag 缓存 | 捐助页内容（标题/markdown 正文/预设金额/支付是否可用） |
| `POST` | `/api/v1/donate/pay` | Bearer Token | 小程序捐助支付下单（可带 nickname/remark；未配置商户时 503） |
| `POST` | `/api/v1/donate/pay-native` | 公开（网页会话可选） | 网页 Native 扫码捐助下单，返回 code_url |
| `GET` | `/api/v1/donate/order-status` | 公开 | 按随机单号轮询支付状态 |
| `POST` | `/api/v1/donate/notify` | 微信支付服务器回调 | 支付结果通知（验签+解密+幂等入账），仅微信支付服务器调用 |
| `GET` | `/api/v1/guides` | 公开 | 学习指南针指南列表（稳定五分类、facets、分页） |
| `GET` | `/api/v1/guides/:guideId` | 公开 | 指南详情：sections/sources/variants |
| `GET` | `/api/v1/guides/:guideId/variants/:variantId` | 公开 | 按需读取转专业学院变体原文 |
| `POST` | `/api/v1/guide-assistant/answers` | 登录 | 学习指南针 AI 问答（检索+引用+拒答） |
| `GET` | `/admin-api/feedback/:id` | `content.read` | 读取单条原文、权威状态和 itemRevision |
| `PATCH` | `/admin-api/feedback/:id` | `content.moderate` | 单条 CAS 处置，原文和归属不可修改 |
| `PATCH` | `/admin-api/feedback/settings` | `content.moderate` | 独立 settingsRevision 设置保存 |
| `GET` | `/admin-api/reviews/:id` | `content.read` | 读取单条原文、权威状态和 itemRevision |
| `PATCH` | `/admin-api/reviews/:id` | `content.edit` | 单条 CAS 处置，原文和归属不可修改 |
| `PATCH` | `/admin-api/reviews/settings` | `content.edit` | 独立 settingsRevision 设置保存 |
| `POST` | `/admin-api/catalog/courses` | `content.edit` | 评价管理"往目录池加课程"（校验+去重） |
| `POST` | `/admin-api/catalog/import-courses` | `content.edit` | 从目录池批量建课程壳（幂等，附 dry_run） |
| `GET` | `/admin-api/ai-settings` | `ai.manage` | 读取 AI 问答配置（Key 掩码） |
| `POST` | `/admin-api/ai-settings` | `ai.manage` | 保存 AI 问答配置（Key/模型/限流，动态生效） |
| `POST` | `/admin-api/ai-settings/test` | `ai.manage` | 用当前或待存配置真实调用一次模型测试连通 |
| `GET` | `/api/v1/courses` | 公开 | 搜索、筛选和分页课程 |
| `GET` | `/api/v1/courses/:courseUid` | 公开 | 课程详情 |
| `GET` | `/api/v1/courses/:courseUid/resources` | 公开 | 课程资源与 R2 下载地址 |
| `GET` | `/api/v1/review-groups` | 公开 | 评价分组列表 |
| `GET` | `/api/v1/review-groups/:groupKey` | 公开 | 某评价分组及评价明细 |
| `PUT` | `/api/v1/reviews/:reviewId/reaction` | 登录 | 标记/取消「有帮助」（同一用户每条评价一个标记） |
| `POST` | `/api/v1/auth/verify` | 服务密钥 | 服务间登录态内省：校验用户 token，返回有效/过期/注销/拉黑 |
| `POST` | `/api/v1/service/blacklist` | 服务密钥 | 批量查询用户黑名单状态（≤100 个） |
| `POST` | `/api/v1/service/rate-limit` | 服务密钥 | 通用固定窗口限流（按服务命名空间隔离） |
| `POST` | `/api/v1/auth/wechat` | 公开、限流 | 小程序微信登录（code 换 token） |
| `POST` | `/api/v1/auth/phone-verify` | 登录、限流 | 微信手机号授权认证（官方 code 换手机号，用于账号追溯） |
| `POST` | `/api/v1/auth/web-register` | 公开、限流 | 网页注册（昵称+密码） |
| `POST` | `/api/v1/auth/web-login` | 公开、限流 | 网页登录（昵称+密码，签发 httpOnly 会话 cookie；空请求用于恢复会话） |
| `POST` | `/api/v1/auth/web-login/start` | 公开、限流 | 发起微信扫码登录：返回票据与小程序码（base64） |
| `POST` | `/api/v1/auth/web-login/confirm` | Bearer Token | 小程序端确认扫码登录（需手机号已验证） |
| `GET` | `/api/v1/auth/web-login/status` | 公开 | 网页轮询票据状态；confirmed 时一次性兑换 httpOnly 会话 |
| `POST` | `/api/v1/auth/logout` | 用户凭证（可失效） | 撤销当前登录令牌并清网页 Cookie，不注销账号 |
| `GET` | `/api/v1/me` | Bearer Token | 当前小程序用户信息 |
| `POST` | `/api/v1/me/avatar` | Bearer Token、multipart、限流 | 上传用户头像（≤2MiB JPEG/PNG，重编码 256px JPEG 剥离元信息，微信同步图片审核通过后返回可绑定地址，不自动绑定资料；每人每日 5 次） |
| `GET` | `/api/v1/me/favorites` | Bearer Token | 我的收藏课程列表（分页） |
| `GET` | `/api/v1/me/reviews` | Bearer Token | 我提交的评价与审核状态（分页） |
| `POST` | `/api/v1/favorites` | Bearer Token | 收藏课程（body：course_id） |
| `DELETE` | `/api/v1/favorites/:param` | Bearer Token | 取消收藏课程 |
| `POST` | `/api/v1/me/profile` | Bearer Token | 更新昵称与头像 |
| `POST` | `/api/v1/me/web-password` | Bearer Token | 设置网页登录密码（微信端首次设置） |
| `POST` | `/api/v1/me/web-password/change` | Bearer Token | 修改网页登录密码（需验证当前密码） |
| `POST` | `/api/v1/me/delete-account` | Bearer Token | 注销账号（保留内容、清身份及业务关联；200确认完成，202仅受理并停用、清理仍待；未配置独立账本503，封禁账号需联系管理员） |
| `GET` | `/api/v1/me/feedback` | Bearer Token | 我的反馈列表（含审核状态） |
| `POST` | `/api/v1/reviews` | 登录且手机号已验证、限流 | 小程序提交评价 |
| `GET` | `/review-api/reviews` | 公开 | 网站读取已通过评价及规则 |
| `POST` | `/review-api/submit` | 登录且手机号已验证、限流 | 网站提交评价 |
| `GET` | `/feedback-api/feedback` | 公开 | 网站读取公开反馈及规则 |
| `POST` | `/feedback-api/submit` | 普通反馈需认证；举报匿名可用、限流 | 网站提交反馈 |
| `POST` | `/feedback-api/report` | 匿名可用、有凭证则验证、限流 | 持久受理始终私密的投诉举报 |
| `GET` | `/visit-api/stats` | 公开 | 读取公开访问统计 |
| `POST` | `/visit-api/hit` | 公开、限流 | 记录访问 |（网站固定路径白名单；另接受 `/mp/<页面名>` 供小程序上报，归入「小程序」类统计。访客记录按 IP+UA 哈希 30 分钟去重，`/admin-api/visit-stats` 面向管理员返回最近访客 IP；公开接口只暴露汇总数字） |
| `GET` | `/editor-settings` | 公开 | 读取公开编辑器工具栏配置 |
| `POST` | `/admin-api/login` | 公开、限流 | 账号+密码登录并签发 Cookie |
| `POST` | `/admin-api/logout` | 公开 | 清除管理员 Cookie |
| `POST` | `/admin-api/upload` | Cookie（需相应权限） | 上传课程文件到 R2 |
| `POST` | `/admin-api/content-images` | Cookie（content.edit） | 上传内容图片（关于/参与/公告等），multipart，归属白名单 owner |
| `POST` | `/admin-api/content-images/cleanup` | Cookie（content.edit） | 清理指定归属未被引用的内容图片 |
| `POST` | `/admin-api/sync-r2` | Cookie（需相应权限） | 从 R2 同步一门课程 |
| `POST` | `/admin-api/sync-r2-all` | Cookie（需相应权限） | 从 R2 重建/合并全部课程树 |
| `POST` | `/admin-api/delete-r2` | Cookie；已禁用 | 旧 R2 删除接口，固定 410 |
| `POST` | `/admin-api/delete-r2-course` | Cookie；已禁用 | 旧课程 R2 删除接口，固定 410 |
| `POST` | `/admin-api/move-r2-prefix` | Cookie；已禁用 | 旧 R2 移动接口，固定 410 |
| `POST` | `/admin-api/r2-publish` | Cookie（需相应权限） | 通过 CAS 安全发布 manifest 与 R2 变更 |
| `GET` | `/admin-api/backup` | Cookie（backup.manage） | 下载加密完整运行备份或明确标注的局部JSON |
| `GET` | `/admin-api/backup-settings` | Cookie（需相应权限） | 读取备份设置（不返回密码） |
| `POST` | `/admin-api/backup-settings` | Cookie（需相应权限） | 更新备份设置和独立保存的密码 |
| `GET` | `/admin-api/editor-settings` | Cookie（需相应权限） | 读取编辑器设置 |
| `POST` | `/admin-api/editor-settings` | Cookie（需相应权限） | 更新编辑器设置 |
| `POST` | `/admin-api/site-icon` | Cookie（content.edit） | 上传站点图标（PNG/JPEG raw body） |
| `DELETE` | `/admin-api/site-icon` | Cookie（content.edit） | 恢复默认站点图标 |
| `GET` | `/admin-api/theme-settings` | Cookie（content.read） | 读取站点配色自定义 |
| `POST` | `/admin-api/theme-settings` | Cookie（content.edit） | 保存站点配色自定义 |
| `DELETE` | `/admin-api/theme-settings` | Cookie（content.edit） | 恢复默认配色 |
| `POST` | `/admin-api/backup-run` | Cookie（需相应权限） | 立即执行备份 |
| `POST` | `/admin-api/backup-test-webdav` | Cookie（需相应权限） | 测试 WebDAV 目标 |
| `GET` | `/admin-api/visit-stats` | Cookie（需相应权限） | 读取完整访问统计 |
| `GET` | `/admin-api/home` | Cookie（需相应权限） | 读取首页内容和 revision |
| `POST` | `/admin-api/home` | Cookie（需相应权限） | 发布首页内容 |
| `GET` | `/admin-api/footer` | Cookie（需相应权限） | 读取页脚内容和 revision |
| `POST` | `/admin-api/footer` | Cookie（需相应权限） | 发布页脚内容 |
| `GET` | `/admin-api/about` | Cookie（需相应权限） | 读取关于页内容和 revision |
| `GET` | `/admin-api/donate` | Cookie（content.read） | 读取捐助页内容与预设金额 |
| `POST` | `/admin-api/donate` | Cookie（content.edit） | 保存并发布捐助页 |
| `GET` | `/admin-api/donate-pay` | Cookie（services.manage） | 读取微信支付配置（脱敏） |
| `GET` | `/admin-api/donate-stats` | Cookie（content.read） | 捐赠统计（总额/来源分布/最近订单） |
| `GET` | `/admin-api/privacy` | Cookie（content.read） | 读取隐私政策 |
| `POST` | `/admin-api/privacy` | Cookie（content.edit） | 发布隐私政策 |
| `GET` | `/admin-api/law-query` | Cookie（所有有效管理员） | 依法调取：按账号/内容聚合证据（每次留痕） |
| `GET` | `/admin-api/law-export` | Cookie（所有有效管理员） | 依法调取：导出 JSON（每次留痕） |
| `GET` | `/admin-api/law-logs` | Cookie（所有有效管理员） | 调取历史：归档及在线记录筛选、分页 |
| `POST` | `/admin-api/donate-pay` | Cookie（services.manage） | 保存微信支付商户配置 |
| `POST` | `/admin-api/about` | Cookie（需相应权限） | 发布关于页内容 |
| `GET` | `/admin-api/participate` | Cookie（需相应权限） | 读取参与贡献页和 revision |
| `POST` | `/admin-api/participate` | Cookie（需相应权限） | 发布参与贡献页 |
| `GET` | `/admin-api/links` | Cookie（需相应权限） | 读取友链页和 revision |
| `POST` | `/admin-api/links` | Cookie（需相应权限） | 发布友链页 |
| `GET` | `/admin-api/feedback` | Cookie（需相应权限） | 读取完整反馈数据和 revision |
| `POST` | `/admin-api/feedback` | Cookie（需相应权限） | 旧客户端兼容：仅单条处置或仅设置，拒绝整库增删及隐式批准 |
| `GET` | `/admin-api/reviews` | Cookie（需相应权限） | 读取完整评价数据和 revision |
| `POST` | `/admin-api/reviews` | Cookie（需相应权限） | 旧客户端兼容：仅单条处置或仅设置，拒绝整库增删及隐式批准 |
| `GET` | `/admin-api/session` | Cookie（需相应权限） | 检查管理会话 |
| `GET` | `/admin-api/manifest` | Cookie（需相应权限） | 读取完整课程树和 revision |
| `GET` | `/admin-api/manifest-verify` | Cookie（需相应权限） | 校对清单：与 R2 只读比对，产出移动/缺失/新增/空发现报告 |
| `POST` | `/admin-api/manifest` | Cookie（需相应权限） | 发布课程树并重建网站 |
| `POST` | `/admin-api/manifest-draft` | Cookie（需相应权限） | 保存课程树草稿，不重建网站 |
| `GET` | `/admin-api/service-keys` | Cookie（services.manage） | 服务密钥列表（不含密钥本体） |
| `POST` | `/admin-api/service-keys` | Cookie（services.manage） | 创建服务密钥（完整密钥仅返回一次） |
| `POST` | `/admin-api/service-keys/:id/enabled` | Cookie（services.manage） | 启用/停用一个服务密钥 |
| `POST` | `/admin-api/service-keys/:id/daily-quota` | Cookie（services.manage） | 修改一个服务的每日调用额度 |
| `POST` | `/admin-api/service-keys-settings` | Cookie（services.manage） | 全局限流设置（limit/窗口上限、默认每日额度） |
| `DELETE` | `/admin-api/service-keys/:id` | Cookie（services.manage） | 删除一个服务密钥 |
| `GET` | `/admin-api/accounts` | Cookie（需相应权限） | 账号列表、权限点与角色预设 |
| `POST` | `/admin-api/accounts` | Cookie（需相应权限） | 创建管理员账号 |
| `PATCH` | `/admin-api/accounts/:param` | Cookie（需相应权限） | 更新账号权限、启用状态或改密提示 |
| `POST` | `/admin-api/accounts/:param/password` | Cookie（需相应权限） | 重置账号密码（body: password, mustChangePassword） |
| `DELETE` | `/admin-api/accounts/:param` | Cookie（需相应权限） | 删除管理员账号 |
| `POST` | `/admin-api/me/password` | Cookie | 修改自己的密码 |
| `GET` | `/admin-api/audit` | Cookie（所有有效管理员） | 分页查询用户/管理员日志，包含已归档记录 |
| `GET` | `/admin-api/mp-users` | Cookie（需相应权限） | 小程序用户列表与登录统计 |
| `POST` | `/admin-api/notify-settings` | `backup.manage` | 设置指南反馈接收开关 |
| `GET` | `/admin-api/notify-settings` | Cookie（需相应权限） | 飞书通知机器人列表（不返回密钥明文） |
| `POST` | `/admin-api/notify-bots` | Cookie（需相应权限） | 新增或更新飞书机器人（webhook/密钥/开关） |
| `DELETE` | `/admin-api/notify-bots/:param` | Cookie（需相应权限） | 删除飞书机器人 |
| `POST` | `/admin-api/notify-test` | Cookie（backup.manage） | 向选定的单个机器人发送测试卡片 |
| `POST` | `/admin-api/mp-users/:param/blocked` | Cookie（需相应权限） | 小程序用户加入/移出黑名单（封禁即无法登录） |
<!-- api-route-registry:end -->

<a id="community-support-api"></a>

## 花、币与等级（2026-10-24 已上线接口，公共基数升级待部署）

沿用现有网站账号、公开资源目录和审核规则，没有新增支付或公开个人贡献接口。r2 已生产部署并通过公网只读核验；r3 公共历史基数补丁已实现但尚待目标服务器迁移。接口 v1 结构和个人统计公式保持，客户端读取服务端最终总量。部署顺序及恢复限制见 [部署说明](DEPLOYMENT.md#community-support-rollout)。

r3 显式迁移完成后，公共鲜花等于一次性权威资料数量基数加全部已成功下载事件；资料基数代表历史资料沉淀，不是历史下载次数，之后不随资料增删重新取值。公共硬币计入历史与新增的全部有效公开评价，按稳定 ID 去重，并随撤下/恢复调整。历史评价没有个人归属，个人花币和等级不补历史，已存在的新贡献不变。home 与下载回执统一返回包含公共基数的最终总量；客户端不再叠加常数。迁移前仍按 r2 的零历史基数运行。

### 能力与开关

`GET /api/v1/home` 保留原字段，增加 `data.community_support`。三个服务器环境开关默认全部为 `0`：`COMMUNITY_SUPPORT_ENABLED`、`COMMUNITY_SUPPORT_DOWNLOAD_REPORTING`、`COMMUNITY_SUPPORT_PERSONAL_STATS`。只有精确 `1` 表示开启；修改后重启生效。

未开启或统计不可用时返回 `{ "version":1, "enabled":false }`，不返回伪零数值；首页其他内容仍可使用。健康且启用时：

```json
{
  "version": 1, "enabled": true, "revision": 2,
  "flowers": 1, "coins": 1, "review_rule": "approved",
  "download_reporting": true, "personal_stats": true
}
```

计数与 revision 为非负安全整数。revision 存入原 SQLite，下载、有效评价变化、个人归属清除在事务中推进，进程重启和开关切换不重置。总量下降也会推进；客户端应拒绝迟到旧 revision。完整旧备份恢复的“新鲜程度”不能由本地哈希证明，须按部署说明人工核对最高已发布 revision，未确认前保持关闭。

### 下载事件

`POST /api/v1/community-support/downloads`，JSON 正文最多 4096 字节，不接受查询参数及下列以外的字段：

```json
{
  "event_id": "mp_example_download_0001",
  "kind": "resource",
  "resource_id": "现有资源接口返回的稳定ID",
  "course_id": "对应课程UUID",
  "attribution": "account"
}
```

- `event_id` 为 16～96 位 `[A-Za-z0-9_-]`。仅在 `downloadFile` 返回 HTTP 200 且有本地文件路径后生成；同一次完成事件重试必须复用原 ID、正文和归属，不能另造 ID。
- `kind=resource` 时，资源及课程 ID 必须匹配当前公开资料目录，ID 长度不超过 200；服务器不接受下载 URL、磁盘路径、用户 ID 或累计数。
- `kind=guide_source` 时 `resource_id` 为指南来源 ID，`course_id` 省略或为 `""`。只有被公开指南/学院变体引用、ID 无歧义、地址位于既有 `resources.nkustudy.top/guide-sources/` 的原件才可计数。未进入后端目录的客户端本地 PDF 不支持此上报。相同来源重复引用同一文件可接受，同 ID 指向不同文件拒绝。
- `attribution=account` 必须使用有效 `Authorization: Bearer ...`，Cookie 不能替代；账号仅取自会话，真正写入前再次检查账号和注销状态。匿名、过期、不合法会话返回 401，不降级匿名。
- `attribution=community` 禁止附带 Authorization，即使携带网页 Cookie 也只计公共数。游客之后登录不补归属；下载期间切换账号应上报 community。

成功 `{code:0,data:{event_id,recorded:true,community_support:{...}}}`。同 ID、同正文和同账号重放仍返回成功但不再次入账、不消耗额度；相同 ID 的正文/归属冲突为 409。被注销清理过归属的 account 事件不能重新绑定或重放。

错误：`400 INVALID_SUPPORT_EVENT`、`401 AUTH_REQUIRED`、`404 RESOURCE_NOT_FOUND`、`409 EVENT_CONFLICT`、`429 RATE_LIMITED`、`503 SUPPORT_UNAVAILABLE`；现有封禁账号规则继续适用。错误不返回 SQL、路径、内部异常或身份数据。计数失败不应阻止客户端使用已下载文件；网络超时不能推断未落账。

持久固定窗口限额：账号总计每分钟 30、每天 200，同账号同资源每分钟 5、每天 50；匿名来源总计每分钟 10、每天 60，同来源同资源每分钟 3、每天 20。限额只对新成功事件消耗；失败事务不增加计数。匿名来源仅保存服务器随机密钥生成的 HMAC 摘要。现有可信代理配置必须保持正确。客户端完成事件仍可伪造，这些额度不构成真实下载/阅读证明，不用于现金或可兑换奖励。

### 本人统计与等级

`GET /api/v1/me/community-support` 仅接受有效 Bearer，不接受包括 `user_id` 在内的任何查询参数，返回 `{code:0,data:{flowers:25,coins:12}}`。不能读取其他账号，响应 `no-store`；个人开关关闭时 503。

等级公式为 `1 + floor(min(flowers, coins) / 10)`；0/0、10/9、10/10、25/12、30/30 分别为 1、1、2、2、4。服务端纯函数验证此口径，接口保留花币两个事实字段供客户端推导。审核冲正后可能降级；等级与捐款、支付和权益无关。

### 评价账本与恢复一致性

- 复用 `isReviewPublicEligible`；保留现有手工审核及配置自动批准规则。新评价只有实际可公开时有效币为 1，待审/隐藏/撤销为 0；重复批准仍为 1，恢复为 1，每条稳定评价 ID 只有一笔当前有效贡献。
- 第一次启用时固定的全部评价 ID（包括待审评价）仍保存在原历史排除基线中。r3 迁移后它只排除个人补币：历史评价无账号归属地参与公共有效币统计；不修改原评价内容或公开资格、不伪造下载事件。迁移只允许维护脚本显式执行一次，无公开写基数接口。
- 评价和私有 `community_support_ledger` 标记（epoch、sequence、历史 ID 基线）在同一个 `reviews.json` 原子替换中保存，完整快照就是 SQLite 投影的持久来源。投影失败不撤销已经成功的正常评价操作。所有统计读/下载写入前同步核对快照；尚在写入、发生回滚或投影失败时统计不可用，不返回旧计数冒充最新值。
- SQLite 事务同时更新有效评价账目与 revision；下载事件、额度和 revision 也同事务提交。**JSON 与 SQLite 之间是可恢复一致性，不宣称跨存储原生同一事务。** 不返回可选的投稿即时到账回执，客户端应在统计接口确认。
- 沿用现有单服务进程写 JSON 的约束。多个 SQLite 连接的幂等测试不代表支持多个 Node 实例共享同一 JSON 目录。
- 源标记缺失/回退、epoch 冲突、已安装源标记但数据库缺失等情况关闭能力，不自动创建新基线或清零。损坏的统计标记原样保留；正常网站内容和审核继续使用，统计待维护者修复。
- 注销保留公共有效总量，清个人贡献、下载/评价归属和账号限流；内部只保留防恢复所需的最小账号清理标记，归属不能重绑。在线注销失败保持 pending；隔离备份恢复重放同样执行清理，失败保留恢复隔离。全量 SQLite 和运行 JSON 均在既有完整备份范围内。

### 管理员账号与权限

管理端使用命名账号（用户名+密码，scrypt 哈希存储）登录。现有权限点共 11 个：
`content.read`（内容查看）、`content.edit`（内容编辑）、`content.moderate`（反馈处理）、
`storage.manage`（R2 同步）、`storage.delete`（R2 删除，已禁用的旧路由除外）、
`backup.manage`（备份管理）、`accounts.manage`（账号管理）、`audit.read`（保留的审计权限点）、
`services.manage`（服务密钥/支付配置）、`ai.manage`（AI 配置）、`law.manage`（保留的调取权限点）。
角色预设：`super_admin`（全部）、`service_admin`（服务配置）、`ai_admin`（AI 配置）、`content_admin`（查看+编辑+反馈处理）、`reviewer`（查看+反馈处理）、`viewer`（只读）。按 C-08，日志查询及三个 `law-*` 入口对所有有效管理员开放，不要求额外 `audit.read/law.manage`，其他管理功能仍按实际权限判断。对外交付另按[内部规程](SECURITY_COMPLIANCE_SOP.md)处理。

- 首次部署会自动创建 `Shview` 超级管理员；初始密码来自一次性环境变量 `ADMIN_INITIAL_PASSWORD`，否则生成随机密码写入数据目录的 `admin-initial-password.txt`（0600），首次登录强制改密。
- 所有非 GET 管理请求、登录成功/失败都会写入审计日志；禁止停用、降级或删除最后一个持有 `accounts.manage` 的启用账号，也不能删除自己的账号。
- 账号与审计数据随备份导出（含密码哈希，不含明文）。

## 小程序微信登录

微信登录和手机号认证是独立步骤；本地代码不证明真实小程序主体、资格及线上配置已核验。运营主体使用已确认的公司信息，完整名称与公开联系信息待负责人核实，不在接口文档编造。

1. 小程序端 `wx.login()` 获取微信登录 `code`；有效性由微信接口判定，不能把网页扫码票据的 5 分钟期限当作登录 code 的本地承诺。
2. `POST /api/v1/auth/wechat`，body `{ "code": "..." }`。服务端用 `WECHAT_APPID` + `WECHAT_APPSECRET`
   调用微信 `code2Session` 换取 openid（AppSecret 只存在于服务器环境变量，绝不下发）。
3. 成功返回 `{ "code": 0, "data": { "token": "...", "expires_in": 2592000, "user": { "id", "nickname", "avatar_url", ... } } }`。
   `token` 有效期 30 天，后续写请求放在 `Authorization: Bearer <token>` 头中。
4. `mp_users` 保存完整 OpenID，微信支付等服务器内部流程会使用；普通用户 `accountUserDto` 不含完整 OpenID、手机号或密码摘要，管理列表只返回 `openid_masked`，受控调取账号 DTO 可包含完整 OpenID 与手机号。这些字段不能公开。
5. 用户 DTO 白名单为 `id/nickname/avatar_url/email/has_web_password/phone_verified/created_at/last_login_at`。昵称（≤32 字符）和头像通过 `POST /api/v1/me/profile` 更新；新的非空头像必须是本站登记、本人已通过审核的资源，不能绑定任意 HTTPS 图片。建议前端使用
   `chooseAvatar` 开放能力按钮和 `type="nickname"` 输入框采集。
6. 错误码：`AUTH_INVALID_CODE`（401，code 无效/过期）、`AUTH_RATE_LIMITED`（429）、
   `MP_AUTH_NOT_CONFIGURED`（503，服务端未配置微信密钥）、`MP_AUTH_UPSTREAM`（502，微信接口异常）。
7. 登录接口限流：每 IP 每分钟 10 次、全局每分钟 240 次。

`POST /api/v1/auth/phone-verify` 请求 `{code}`，需要有效用户凭证，使用微信官方手机号授权码，不能直接填手机号。成功 `data:{ok:true,phone_masked}`，服务器保存原手机号与认证时间；缺配置 503、码重放 409、上游失败 502。公开评价和普通反馈须账号有效、未封禁且认证完成；匿名私密投诉不要求认证。手机号认证、账号或 IP 关联用于站内追溯，不等于已核验自然人的法律身份，也不保证内容合规。

### 网页用户会话与本人接口

- `POST /api/v1/auth/web-register` 接收 `{nickname,password,email?}`，保存可选邮箱和密码摘要；`web-login` 接收 `{nickname,password}`。二者返回 `data:{user}`，通过 `nkustudy_web_session` 下发 HttpOnly/Secure/SameSite=Lax Cookie，不把令牌放入网页 JSON。空 `{}` 登录请求只恢复既有有效会话，不重新签发令牌。
- 用户 Bearer 及网页 Cookie 对应同一令牌存储，默认绝对有效期均为 30 天；恢复会话/内省不续期。扫码票据有效期为 5 分钟且确认后一次性兑换。账号封禁、持久注销或凭证撤销使后续鉴权失败。
- `GET /api/v1/me` 返回上述用户白名单；`POST /api/v1/me/profile` 接收 `{nickname?,avatar_url?}`，返回 `data:{user}`。邮箱目前可在注册时提交，资料更新接口不接受邮箱修改。
- `GET /api/v1/me/favorites` 返回 `{items,total,page,page_size}`；`POST /api/v1/favorites` 请求 `{course_id}`，`DELETE /api/v1/favorites/:param` 取消。新调用方使用 manifest `uid`；收藏服务兼容旧 manifest `id` 输入并规范为 UID，勿把兼容输入当作稳定标识。
- `GET /api/v1/me/reviews` 与 `me/feedback` 分页返回本人投稿及允许返回的处理状态/回复；不会使私密投诉公开，匿名回执 ID 无公开读取接口。注销后不能继续通过原账号读取。
- `POST /api/v1/me/web-password` 接收 `{password}` 为未设置网页密码的账号首次设置；`web-password/change` 接收 `{current_password,new_password}` 并校验原密码。
- `POST /api/v1/auth/logout` 撤销当前令牌并清网页 Cookie，返回 `{revoked}`；它是退出登录，不能代替账号注销。

### `POST /api/v1/me/delete-account`

需要有效用户凭证，无需再提交身份字段。封禁账号不能自助注销（403）；未配置独立账本返回 `503 ACCOUNT_DELETION_UNAVAILABLE`。持久受理后撤销全部令牌及扫码票据，阻止旧账号登录/写入，并清网页 Cookie：

- `200` 且 `data.deleted=true,pending=false,accountDisabled=true` 才表示当前必要清理已确认完成；
- `202` 且 `data.deleted=false,pending=true,accountDisabled=true` 表示已受理并停用、资料清理待重试，客户端不得报完整成功或自动重复提交；
- 错误、超时或无法解析的响应表示结果尚未确认，不能仅凭导航或 Cookie 清除判断完成。

采用 `s5-retain-published-v1`：清账号 OpenID/密码摘要/手机与认证时间/邮箱/原昵称/头像地址/收藏；保留评价、反馈、私密投诉原文与原可见性，清业务归属、联系方式及直接身份副本，移除本人投票。保留必要支付事实并清身份，精确订单键处理公开昵称；无键旧记录人工核对。受限历史日志、最小注销账本/作业与旧加密备份保留各自例外，正文自述信息、历史缓存和未登记头像不承诺自动彻底清除。200 不表示已清除全部历史/第三方副本或生产已验。完整策略与隔离恢复见 [S5 策略](compliance/S5_POLICY.md)和[S5 运维说明](compliance/S5_OPERATIONS.md)。

### 课程目录与评价选课

- `GET /api/v1/catalog?q=<关键词>&page=&page_size=`：来自教务选课手册的课程目录（课程名/开课单位/归属模块/授课教师/开设学期）；关键词同时匹配课程名与教师名。
- `POST /api/v1/reviews` 支持两种课程定位：
  - `course_id`：课程库（manifest）课程的 uid，教师为自由文本（兼容现状）；
  - `catalog_course_id`：课程目录中的课程 id；此时教师必须从该课程的授课教师列表中选择，否则返回 `400 TEACHER_NOT_IN_CATALOG`（教师列表为空的课程允许自由填写）。

## 通用约定

### Content-Type 与请求大小

- 除上传外，POST 请求应发送 `Content-Type: application/json` 和 UTF-8 JSON。当前服务按正文解析 JSON，并未依赖该请求头判断格式；调用方仍应正确设置请求头。
- JSON 正文上限为 **2,000,000 字节**。无效 JSON、无效 UTF-8、请求中止返回 `400`；超限在旧接口和管理接口通常返回 `413`。公共 v1 路由会把正文读取失败统一映射为 `400 INVALID_JSON`，超限时底层还会关闭请求连接。
- `/admin-api/upload` 使用 `multipart/form-data`，限制每次最多 20 个文件、20 个 multipart part、每个文件最多 100 MiB。
- `/admin-api/content-images` 使用 `multipart/form-data`，单文件 ≤8MB，仅 png/jpeg/webp/gif，存入 R2 `content/<owner>/` 前缀；内容保存时自动删除不再引用的同归属图片。
- 所有服务端 JSON 响应均为 `application/json; charset=utf-8`。`GET /admin-api/backup` 额外返回 `Content-Disposition: attachment`，其中 `scope=all` 使用 `application/octet-stream` 返回加密包。

### 缓存、ETag、CORS

公开服务在进程内复用 manifest/reviews 快照与匿名评价分组：每次访问检查文件指纹，原子替换或数据改变立即失效，最长 3 秒强制重读。读取失败不会返回旧成功快照；健康检查始终重读。登录用户的 `viewer_reaction` 单独生成，不能复用其他用户的值。此缓存不改变下述 HTTP 缓存约定，也不改变管理端写入、审核和发布回滚流程。

- 含评价派生内容的 `/api/v1/home`、`courses`（含详情）、`review-groups`（含详情）、`search-index`、`search-data` 使用 `Cache-Control: no-store`，不生成 `ETag`，不因旧 `If-None-Match` 返回 `304`，使隐藏或撤销后下一次读取使用当前公开状态。
- 其余可缓存公共 GET（如 guides/catalog/about）成功响应带 `ETag`，并使用 `Cache-Control: public, max-age=60, stale-while-revalidate=300`。携带匹配的 `If-None-Match` 会返回 `304`、无正文。
- `/api/v1/health`、身份/本人及订单状态读取、所有 POST、所有旧公开/管理接口均为 `Cache-Control: no-store`。
- Node 路由当前**不设置** `Access-Control-Allow-Origin`，也没有 `OPTIONS` 预检路由。浏览器代码应与站点同源；微信小程序不使用浏览器 CORS，但必须在微信公众平台配置合法 request 域名。

### 公共 v1 响应与错误

成功：

```json
{ "code": 0, "data": {} }
```

失败：

```json
{ "code": "COURSE_NOT_FOUND", "message": "课程不存在。" }
```

稳定错误码包括：

| HTTP | `code` | 含义 |
| --- | --- | --- |
| 400 | `INVALID_PATH` | 路径参数不是合法 URL 编码 |
| 400 | `INVALID_PAGINATION` | `page` 或 `page_size` 不是允许范围内的正整数 |
| 400 | `INVALID_GUIDE_CATEGORY` | 指南分类不在公开枚举中 |
| 400 | `INVALID_JSON` | 提交正文无法读取为 JSON |
| 400 | `INVALID_REVIEW` | 教师、1–5 分整数评分或最短正文等校验失败 |
| 404 | `NOT_FOUND` | v1 路由或方法不存在 |
| 404 | `COURSE_NOT_FOUND` | 课程 UID 不存在 |
| 404 | `GUIDE_NOT_FOUND` | 指南稳定 ID 不存在 |
| 404 | `REVIEW_GROUP_NOT_FOUND` | 评价分组不存在 |
| 409 | `SUBMISSION_CLOSED` | 评价提交已关闭 |
| 429 | `RATE_LIMITED` | 尝试或正式提交超过限额 |
| 500 | `INTERNAL_ERROR` | 未预期的服务端错误；不会向客户端返回内部异常文本 |

旧公开接口和管理接口使用 `{ "ok": true, ... }`；错误一般为 `{ "ok": false, "error": "..." }`，校验/发布错误也可能带 `errors`、`currentRevision`、`rolledBack`。常见 HTTP 状态是 `400`、`401`、`403`、`409`、`410`、`413`、`429`、`500`，发布状态不确定时可为 `503`。

## 公共小程序 API（`/api/v1`）

### 公共数据对象

课程对象只包含以下字段：

```json
{
  "id": "8b0d8d1a-...",
  "name": "课程名称",
  "short_name": "课程简称",
  "aliases": ["课程别名"],
  "summary": "课程摘要",
  "description": "课程摘要",
  "term": "大一下",
  "group": "通识必修课",
  "category_name": "通识必修课",
  "tags": ["数学"],
  "assessment": "绩点制",
  "teachers": ["教师姓名"],
  "teacher_groups": [
    { "id": "group-key", "group_key": "group-key", "teacher_name": "教师姓名", "teacher_name_short": "姓名", "review_count": 2 }
  ],
  "resource_count": 10,
  "review_count": 2,
  "offering_count": 1,
  "ratings": { "average": 4.5, "count": 2, "show_aggregate": true },
  "updated": "2026-08-15"
}
```

`id` 是不可变课程 UUID（manifest 的 `uid`），不是可编辑的课程名称或网站路由 `id`。`short_name` 与 `aliases` 分别只来自 manifest 的 `shortName` 和 `aliases`；空值为 `""` 和 `[]`，服务端不会猜别名。教师列表来自已通过评价的真实 `课程名 + 教师` 分组；没有评价时不会虚构教师安排。

资源对象：

```json
{
  "id": "stable-resource-hash",
  "course_id": "course-uuid",
  "course_name": "课程名称",
  "title": "2025年期末试题.pdf",
  "size": 238817,
  "size_label": "233 KB",
  "description": "期末试题",
  "section": "往年真题",
  "type": "往年真题",
  "term_label": "大一下",
  "extension": "PDF",
  "download_url": "https://resources.nkustudy.top/resources/..."
}
```

评价分组对象：

```json
{
  "group_key": "stable-group-hash",
  "course_id": "course-uuid-or-null",
  "course_name": "课程名称",
  "teacher_name": "教师姓名",
  "matched": true,
  "review_count": 2,
  "rating_average": 4.5
}
```

评价明细对象只含 `id`、`teacher_name`、`rating`、`tags`、`body`、`helpful_count`、`created_at`。

### `GET /api/v1/health`

- 参数/正文：无。
- 成功 `200`（注销服务已配置）：`{ "code": 0, "data": { "status": "ok", "accountDeletion": { "configured": true, "pending": 0, "ledgerSequence": 0 } } }`。
- `accountDeletion.pending` 为待处理注销作业数，`ledgerSequence` 为已受理账本序号；未配置注销服务时该对象仅为 `{ "configured": false }`。健康响应固定 `Cache-Control: no-store`；`status: "ok"` 不等于远端清理或生产整体验收完成。
- 主要错误：运行时 manifest/reviews 不可用时 `500 INTERNAL_ERROR`。

```bash
curl -sS https://nkustudy.top/api/v1/health
```

### `GET /api/v1/home`

- 参数/正文：无。
- 成功 `200`：`data.announcement`、`data.hot_courses`（最多 6 个课程对象）、`data.latest_updates`（最多 8 个 `{id,title,summary,updated}`）。
- 排序：热门课程依次按评价数、资源数、中文课程名；最新更新按 `updated` 倒序。

```bash
curl -sS https://nkustudy.top/api/v1/home
```

### `GET /api/v1/search-index`

- 参数/正文：无；一次返回同一快照中的全部公开课程、教师、资料和指南索引项，不是分页候选集。
- 成功 `data`：`{version,generated_at,items,total}`。`version` 是白名单索引内容的 SHA-256 摘要截断值，内容不变则稳定；`generated_at` 是该快照所依赖的最新公开内容时间，使用带时区的 ISO 8601。
- 每项共有 `id`、`type`、`type_label`、`badge`、`name`、`short_name`、`aliases`、`tags`、`teachers`、`search_text`、`subtitle`。缺失字符串为 `""`，缺失数组为 `[]`；`type` 只可能是 `course`、`teacher`、`resource`、`guide`。
- 教师只来自已通过且能精确匹配现有课程的评价分组；相同规范化姓名合并，稳定 ID 为姓名的确定性哈希。当前没有权威教师注册表，因此无法区分同名教师，姓名修正会改变该 ID。
- 资料项额外返回 `course_id`、`course_name`、`resource_type`、`term_label`，不返回路径或下载地址；客户端跳转所属课程资料页。
- 指南项额外返回 `category`、`updated_at`。课程项的简称/别名只读取网站源数据。

```json
{
  "code": 0,
  "data": {
    "version": "stable-content-hash",
    "generated_at": "2026-08-16T04:00:00.000Z",
    "items": [{
      "id": "course-uuid",
      "type": "course",
      "type_label": "课",
      "badge": "课",
      "name": "有机化学",
      "short_name": "有机",
      "aliases": ["有机化学基础"],
      "tags": ["化学"],
      "teachers": ["教师姓名"],
      "search_text": "课程摘要 学期 类别 考核方式",
      "subtitle": "专业必修课 · 大二上"
    }],
    "total": 1
  }
}
```

### `GET /api/v1/guides`

学习指南针公共指南列表（无需登录，只读）。数据来自版本化内容快照 `server/data/learning-compass-snapshot.json`（5 分类、18 篇 published 指南、29 个转专业学院变体）。

查询参数：`category` 可为空或取稳定五分类 `course-study`、`exam-grade`、`student-status-graduation`、`academic-development`、`rules-rights`；`page` 默认 1，`page_size` 默认 20、最大 100。未知分类返回 `400 INVALID_GUIDE_CATEGORY`。

成功 `data` 为 `{items,total,page,page_size,facets,data_updated_at}`：

- 列表项（GuideSummary）：`id`、`title`、`summary`、`category`、`category_label`、`applicable_scope`、`updated_at`、`time_status`（`long_term|current|ended|historical`）、`content_type`（`standard|multi_variant`）、`read_minutes`、`source_count`、`aliases`、`tags`。
- `facets.categories` 为对象数组 `[{value,label,order,count}]`，只列当前有已发布内容的分类。
- 旧字段 `steps/source_title/source_url` 已按产品决定直接移除（未公测，无兼容窗口）。

### `GET /api/v1/guides/:guideId`

- `guideId` 是内容快照中发布后不变的稳定 ID。
- 成功字段（GuideDetail）：`id`、`title`、`summary`、`category`、`category_label`、`applicable_scope`、`updated_at`、`time_status`、`content_type`、`read_minutes`、`sections[{id,title,body_format,body,source_ids}]`、`sources[{id,title,document_no,publisher,published_at,file_type,file_name,file_url,official_page_url,location_label}]`、`variants[{id,title,order,source_count}]`、`related_courses`、`correction_url`。
- `sections[].body` 为忠实于官方原文的 Markdown；`sources[].file_url` 指向 R2 公网域名 `https://resources.nkustudy.top/guide-sources/...`，浏览器与小程序 `downloadFile` 均可直接访问，不经应用服务器代理。
- 多学院指南（`transfer-major-2026`）详情只返回校级章节和 29 个轻量 `variants`，不携带 150 个学院原文块；学院正文按需经 variants 接口加载。
- 主要错误：`400 INVALID_PATH`、`404 GUIDE_NOT_FOUND`。

### `GET /api/v1/guides/:guideId/variants/:variantId`

- 按需读取一个转专业学院/单位的逐字原文。当前仅 `transfer-major-2026` 是 `multi_variant`。
- 成功 `data` 为 `{guide_id, variant:{id,title,order,sections[{id,title,body_format,body,source_ids}],sources[]}}`；`sections[].body` 为该学院官方原文件的 Markdown 全文，学院之间内容不串用。
- 主要错误：`400 INVALID_PATH`、`404 GUIDE_NOT_FOUND`、`404 GUIDE_VARIANT_NOT_FOUND`。

### `POST /admin-api/catalog/courses`

管理后台「评价审核」面板的"往目录池加课程"：课程不在课程库/目录时，管理员提交课程名/学院/教师/学期，通过校验后**直接写入课程目录**（`catalog.json`）并热生效——网页与小程序评价立即可搜索并提交该课程。

- 权限：`content.edit`。
- 请求体：`{ name, categories?, teachers, terms? }`；`name` 2–120 字、`teachers` 必填（字符串或数组，支持顿号/逗号分隔，去重后最多 20 位）；`categories` 最多 5 项。
- 去重：与目录课程（含别名、忽略空白/全半角括号）及课程库标题重复时返回 `400`，`code=CATALOG_COURSE_EXISTS`（提示可直接填写课程名提交评价）。
- 成功 `data`：`{ submitted:true, course:{id,name,categories,teachers,terms} }`；同时向飞书通知"目录新增课程"。新增条目带 `origin:"user"` 标记便于区分教务来源。

### `POST /api/v1/guide-assistant/answers`

学习指南针 AI 问答（B 批）。必须携带小程序登录 Bearer Token：`Authorization: Bearer <token>`。

请求体（全部字段校验在 provider 调用前完成）：

```json
{
  "question": "课程成绩有异议，如何申请复核？",
  "history": [{ "role": "user", "content": "…" }, { "role": "assistant", "content": "…" }],
  "profile": { "admission_year": 2025, "major": "用户主动填写的专业" }
}
```

- `question` 必须是原始字符串，1–1000 字；`history` 最多9个完整轮次（偶数条），按`user/assistant`成对交替，每条content必须是原始字符串且最多1000字。`profile.major`必须是字符串，不能由数组/对象强制转换；`admission_year`接受四位年份数字或字符串（JSON解析后按值验证，不声称区分数字2025与等值科学记数法）。
- 检索、来源冲突判断和模型输入共用有效话题上下文：省略式追问保留最近主题，明确的新主题不再发送旧历史。历史助手回答不作为事实依据。
- 依据按发布快照中的学院变体、年级、学年/学期和时效元数据保守过滤。当前就读/转出学院不能当作转入目标，专业不自动映射学院；条件不清只用校级一般材料或拒答。历史/已结束材料须有明确历史意图及对应年份；不能据标签认定具体申请窗口仍开放。知识负责人仍需核验来源时效、资格及缺失映射。
- 请求体按UTF-8字节独立限制为64KiB，公开读取helper向底层解析器传递该限制并保持严格文本校验；超限返回JSON `413 AI_BODY_TOO_LARGE`而不直接重置连接。每字段字符上限不取消整体字节上限；其他路由仍使用各自原限制。
- 服务端顺序：Token验证 → 受限正文读取 → 再核身份 → 同用户单进程并发单飞 → 输入校验 → 限流 → 适用范围检索及冲突/无依据/引用缺失拒答 → 调用已配置provider → 文字拒答规范化 → 再核身份并返回。
- 限流默认每用户每日20次、分钟3次、全局每日2000次（SQLite持久化窗口）；实际取值以管理配置为准。本候选不改变线上额度。
- 服务端总预算 25 秒（严格小于客户端 30 秒超时并保留传输余量），重试服从剩余预算，provider 失败最多自动重试 1 次，仍失败返回 `503 AI_UNAVAILABLE`。
- 依据不足/来源冲突返回 `200` 业务拒答：`data.refused=true`，`reason` 为 `INSUFFICIENT_EVIDENCE|SOURCE_CONFLICT` 之一，不调用模型、不编造；模型以文字表达的拒答（`REFUSE_INSUFFICIENT` 标记或简短拒答话术）同样规范化为该结构化拒答。
- 成功响应 `data`：`answer`（≤12000 字，超出截断）、`refused:false`、`reason:null`、`guide_id`、`category`（首选依据所属指南）、`applicable_scope`、`freshness_notice`、`citations[{id,title,document_no,publisher,published_at,file_type,file_url,official_page_url}]`（整份原文件级引用，`file_url` 为 R2 公网直链）。
- 模型密钥存于受限0600配置文件，非加密存储；管理读回仍仅掩码。环境变量仅在配置文件明确不存在时作为首次种子；已持久化的空Key不得从环境复活。损坏/不可读/非法地址配置关闭调用并返回`configuration_error:AI_CONFIGURATION_INVALID`，不能静默换供应商。
- 主要错误：`400 INVALID_AI_QUESTION`、`401 AUTH_REQUIRED`、`413 AI_BODY_TOO_LARGE`、`429 RATE_LIMITED`、`503 AI_UNAVAILABLE`。

#### AI配置保存、测试与地址绑定

`POST /admin-api/ai-settings`与`POST /admin-api/ai-settings/test`共用有效配置计算。测试接受与保存相同的`{settings,api_key?,clear_api_key?}`，兼容既有平铺字段；只预览、不保存，使用当前完整表单中的地址/模型/Key。首次未保存的新配置也可测试；缺Key/关闭状态仍不发请求。

HTTPS地址采用统一规范化，默认443/主机大小写/尾斜杠等价形式保持同一目的地；微信限定`chatapi.weixin.qq.com/openai/v1`，保留现有阿里HTTPS域范围。userinfo、非默认端口、query、fragment及不允许的地址拒绝。最终provider不跟随重定向。更改规范化后的目的地必须显式提供Key或明确清除；只修改同地址模型/限流可保留Key。保存非法配置返回受控400，测试返回受控失败，不得自动换成默认供应商继续携带旧Key。

以上为本地修复候选契约，尚不表示已部署。回退旧r3的AI配置预检及保持AI关闭要求见[部署说明](DEPLOYMENT.md#ai-rollback-guard)。

### `GET /api/v1/courses`

查询参数：

| 参数 | 默认值/限制 | 语义 |
| --- | --- | --- |
| `page` | `1`；1–1,000,000 的整数 | 页码 |
| `page_size` | `20`；1–100 的整数 | 每页数量 |
| `q` | 空；规范化后最多 200 字符 | 在名称、简称、别名、摘要、term、group、assessment、标签和教师中包含匹配，不区分大小写 |
| `term` | 空；最多 120 字符 | 与服务器原值精确匹配 |
| `group` | 空；最多 120 字符 | 与服务器原值精确匹配 |
| `tag` | 空；最多 120 字符 | 必须包含该服务器标签 |
| `assessment` | 空；最多 120 字符 | 与服务器原值精确匹配 |

未知查询参数被忽略。成功 `data`：

```json
{
  "items": [],
  "total": 0,
  "page": 1,
  "page_size": 20,
  "facets": { "groups": [], "terms": [], "tags": [], "assessments": [] }
}
```

筛选值和 facets 直接复用网站数据；没有学年、校区、`category`、`sort` 字段。

```bash
curl -G -sS https://nkustudy.top/api/v1/courses \
  --data-urlencode 'q=概率论' \
  --data-urlencode 'group=通识必修课' \
  --data-urlencode 'page=1' \
  --data-urlencode 'page_size=20'
```

### `GET /api/v1/courses/:courseUid`

- 路径参数 `courseUid`：课程不可变 UUID，需 URL 编码。
- 成功 `200`：`data` 为课程对象。
- 主要错误：`400 INVALID_PATH`、`404 COURSE_NOT_FOUND`。

```bash
curl -sS 'https://nkustudy.top/api/v1/courses/<COURSE_UID>'
```

### `GET /api/v1/courses/:courseUid/resources`

- 路径参数同上。
- 成功 `200`：`{ "code":0, "data": { "course_id":"...", "items":[], "total":0 } }`。
- `.openlist` 占位文件不返回。
- `download_url` 是经来源与路径校验后生成的 R2 公网 URL；下载**不经过 Node 代理**。小程序需把 `https://resources.nkustudy.top` 配为合法 `downloadFile` 域名。
- 主要错误：`400 INVALID_PATH`、`404 COURSE_NOT_FOUND`、资源根配置异常时 `500 INTERNAL_ERROR`。

```bash
curl -sS 'https://nkustudy.top/api/v1/courses/<COURSE_UID>/resources'
```

### `GET /api/v1/review-groups`

- 参数/正文：无。
- 成功 `200`：`data.items` 为评价分组对象，`data.total` 为分组数；列表不含评价明细。
- 只处理状态为 `approved`/`通过` 且未隐藏的评价。

```bash
curl -sS https://nkustudy.top/api/v1/review-groups
```

### `GET /api/v1/review-groups/:groupKey`

- 路径参数 `groupKey`：由精确 trim 后的 `courseTitle + NUL + teacher` 做 SHA-256 并截取 24 位 base64url 得到，不应由客户端猜测；从列表响应读取。
- 成功 `200`：评价分组对象，并增加 `items` 评价明细数组。
- 历史评价未精确匹配现有课程时仍保留：`matched:false`、`course_id:null`。
- 主要错误：`400 INVALID_PATH`、`404 REVIEW_GROUP_NOT_FOUND`。

```bash
curl -sS 'https://nkustudy.top/api/v1/review-groups/<GROUP_KEY>'
```

### 服务间接口（X-Service-Key）

供团队其他服务（机器人、指南/AI 后端等）复用本站登录态与风控。调用方先由管理员在
`/admin-api/service-keys` 创建服务密钥（`nkusvc_` 前缀，仅创建时完整展示一次），随后在请求头携带
`x-service-key: <密钥>`。密钥停用/删除立即生效。

### `POST /api/v1/auth/verify`

请求 JSON：`{ "token": "<用户 Bearer token（可带或不带 Bearer 前缀）>" }`

- 成功 `200`：`{ "active": true, "user_id": 7, "nickname": "同学", "blocked": false, "expires_at": 1893456000000 }`
- 无效时 `active:false` 且 `reason` 为 `malformed` / `revoked`（已注销）/ `expired`（已过期，附 `expires_at`）/
  `blocked`（用户被拉黑，附 `user_id`）/ `deleted`（用户已注销账号）。
- 内省为只读：不刷新滑动过期。拉黑用户的 token 立即视为 `active:false`。

### `POST /api/v1/service/blacklist`

请求 JSON：`{ "user_ids": [1, 2, 3] }`（最多 100 个，超出只取前 100）

- 成功 `200`：`{ "users": [{ "user_id": 1, "exists": true, "blocked": false }, ...] }`
- 管理员在后台「小程序用户」里拉黑/解除，本接口实时反映。

### `POST /api/v1/service/rate-limit`

请求 JSON：`{ "scope": "chat", "key": "user-7", "limit": 20, "window_ms": 60000 }`

- `scope` 只保留 `[A-Za-z0-9_.-]`；实际计数命名空间为 `svc:<服务ID>:<scope>`，服务之间互不影响。
- limit / window_ms 的上限、每个服务的每日调用总量均由管理员在后台「服务密钥」页配置，不在代码里写死；
  超过每日额度的服务会得到 `429 SERVICE_QUOTA_EXCEEDED`。
- `limit` 1-10000；`window_ms` 1000-86400000；每次调用消耗 1。
- 成功 `200`：`{ "allowed": true, "scope": "svc:svc-xxx:chat", "count": 1, "limit": 20, "remaining": 19,
  "reset_at": 1893456000000, "retry_after_ms": 0 }`
- 超限时 `allowed:false` 且 `retry_after_ms > 0`，`count/remaining` 反映已用量。
- 主要错误：`400 INVALID_RATE_LIMIT_INPUT`、`401 SERVICE_KEY_REQUIRED`。

```bash
curl -sS -X POST 'https://nkustudy.top/api/v1/service/rate-limit'   -H 'x-service-key: nkusvc_xxx' -H 'content-type: application/json'   -d '{"scope":"chat","key":"user-7","limit":20,"window_ms":60000}'
```

### `PUT /api/v1/reviews/:reviewId/reaction`

- 需要小程序登录 Bearer Token。
- 请求 JSON：`{ "reaction": "up" }` 标记「有帮助」；`{ "reaction": null }` 取消标记。仅支持 `up`。
- 同一用户对同一条评价只保留一个标记，重复标记幂等。
- 成功 `200`：`{ "review_id", "helpful_count", "viewer_reaction" }`。
- 登录后获取评价分组明细时，每条评价额外返回 `viewer_reaction`（`"up"` 或 `null`）。
- 主要错误：`400 UNSUPPORTED_REACTION`、`401 AUTH_REQUIRED`、`404 REVIEW_NOT_FOUND`。

```bash
curl -sS -X PUT 'https://nkustudy.top/api/v1/reviews/<REVIEW_ID>/reaction'   -H 'authorization: Bearer <TOKEN>' -H 'content-type: application/json'   -d '{"reaction":"up"}'
```

### `POST /api/v1/reviews`

请求 JSON：

```json
{
  "course_id": "course-uuid",
  "teacher": "教师姓名",
  "rating": 5,
  "tags": ["讲解清晰"],
  "body": "评价正文",
  "website": ""
}
```

- `course_id` 必须存在；`teacher` 最多 80 字符；`rating` 必须为 1–5 的整数；`body` 最多 2000 字符且长度不小于当前服务端 `rules.minLength`；tags 去重后最多 12 个、每项最多 40 字符。
- `website` 是反机器人蜜罐字段，应留空。非空时返回 `200` 但不写评价，`submitted/accepted` 均为 `false`；客户端不能把它展示为已受理。
- 持久提交成功 `200`：`{ "code":0, "data": { "submitted":true, "accepted":true, "pending":true } }`；`pending` 由网站的同一份评价规则决定，符合自动公开规则时为 `false`。
- 限流：先按 IP 统计尝试，每分钟 30 次、全局每分钟 1000 次；有效提交再按规则的 `hourlyLimit`、`dailyLimit` 持久化限流，默认分别为 3、10。
- 小程序和网站共用同一评价写入服务、审核队列和 `reviews.json`，不会产生第二套评价数据。

```bash
curl -sS https://nkustudy.top/api/v1/reviews \
  -H 'Content-Type: application/json' \
  --data '{"course_id":"<COURSE_UID>","teacher":"张老师","rating":5,"tags":["讲解清晰"],"body":"课程内容充实，复习建议具体。","website":""}'
```

## 网站旧公开接口

这些接口继续服务现有 Astro 网站。新小程序优先使用 `/api/v1`。

### `GET /review-api/reviews`

- 成功：`{ "ok":true, "reviews":[...], "rules":{...} }`。
- `reviews` 仅含通过服务器公开资格判断且未隐藏的记录；使用字段白名单，不返回账号归属、昵称、头像、联系方式、手机号、OpenID、`ipHash` 或 `userAgent`。正文自述信息仍可能出现；保留网站所需的 `courseTitle`、`teacher`、`rating`、`tags`、`content`、状态和时间字段。
- `rules` 是当前评价规则，含开关、审核要求、限流值、最短长度、公告和备注。

```bash
curl -sS https://nkustudy.top/review-api/reviews
```

### `POST /review-api/submit`

请求：`{courseTitle, teacher, rating, tags?, content, website?}`。字段长度、审核、蜜罐和限流与 v1 评价提交共用同一服务；这里直接按课程标题写入，因此允许提交尚未匹配 manifest 的历史/新课程标题。

成功受理：`{ "ok":true, "accepted":true, "pending":true|false }`，是否待审取决于相同配置规则。蜜罐返回 `accepted:false`，旧网站接口不返回 v1 的 `submitted` 字段。需要登录、手机号认证和有效账号；主要错误：`400` 无效评价/JSON、`401` 未登录、`403` 未认证/封禁、`409` 关闭提交、`429` 限流、`413` 正文超限。

```bash
curl -sS https://nkustudy.top/review-api/submit \
  -H 'Content-Type: application/json' \
  --data '{"courseTitle":"概率论","teacher":"张老师","rating":5,"content":"评价正文至少达到管理员设置的最短长度。","website":""}'
```

### `GET /feedback-api/feedback`

成功：

```json
{
  "ok": true,
  "title": "问题与建议",
  "announcement": "",
  "rules": { "submissionOpen": true, "minLength": 5 },
  "items": []
}
```

仅返回具有有效服务器公开依据、非私密、非 blocked、未隐藏的条目。公开依据包含S3管理员明确决定，以及按用户2026-10-06决定导入的v1既有公开反馈；历史导入范围和来源记录见下文S3单条处置。`handlingStatus` 与 `publicationState` 分开；新投稿处理完成、回复、取消隐藏都不产生公开资格。公开 DTO 永不含账号归属、IP、UA、联系方式、举报引用或内部来源字段；`reply/repliedAt` 仅在 `replyVisibility=public` 且条目可公开时返回。既有公开回复由迁移保留；缺失的历史回复时间不补造。

```bash
curl -sS https://nkustudy.top/feedback-api/feedback
```

### `POST /api/v1/me/avatar`

`multipart/form-data` 单文件字段 `file`，用户凭证鉴权。限制：JPEG/PNG、≤2 MiB（2,097,152 字节）、解码尺寸 ≤4096×4096。服务端重编码为 256×256 居中裁剪 JPEG（剥离图片元信息）后送微信同步图片审核（`img_sec_check`），通过后存入 R2 `avatars/` 前缀并登记归属，返回公开资源地址（每次上传新 ID）。S5 新上传使用 `Cache-Control:no-store`，不能据此宣称旧一年缓存或第三方副本已经清除。**上传不自动绑定资料**，需另行 `POST /api/v1/me/profile` 传回 `avatar_url` 绑定（仅允许本人已过审资源，否则 403 `AVATAR_NOT_OWNED`）。限流每用户每日 5 次。

```json
{ "code": 0, "data": { "avatar_url": "https://resources.nkustudy.top/avatars/<opaque-id>.jpg" } }
```

错误码：400 `AVATAR_INVALID_IMAGE`（缺文件/解码失败）、403 `AVATAR_CONTENT_REJECTED`（审核拒绝）、403 `AVATAR_NOT_OWNED`（绑定非本人资源）、413 `AVATAR_TOO_LARGE`、429 `RATE_LIMITED`、503 `AVATAR_UPLOAD_UNAVAILABLE`（存储/审核暂不可用）。上传成功但未绑定的资源 24 小时后自动回收；旧头像在新头像绑定成功前不删除。

### `POST /api/v1/auth/web-login/start`

发起微信扫码登录。成功：`{ "code":0, "data":{ "ticket":"...", "expires_in":300, "qr_available":true, "qr_image":"data:image/png;base64,..." } }`。`qr_image` 为小程序码（scene=票据），未配置小程序凭据时 `qr_available:false`，可改用手动输入票据（小程序「网页登录确认」页）。

### `POST /api/v1/auth/web-login/confirm`

小程序端确认：`{ "ticket":"..." }`，需 Bearer Token 且手机号已验证（否则 `403 PHONE_VERIFY_REQUIRED`）。成功 `{ "code":0, "data":{ "confirmed":true } }`。

### `GET /api/v1/auth/web-login/status`

网页轮询 `?ticket=`。`pending` / `confirmed`（本次响应即兑换，Set-Cookie 下发网页会话，票据一次性）/ `used` / `expired`。

### `POST /feedback-api/submit`

请求：`{type?, title, content, contact?, website?}`。`type` 最多 40 字符，空值默认为 `bug`；标题最多 120 字符；正文最多 2000 字符且达到规则最短长度；联系方式最多 120 字符。`website` 为蜜罐，应留空。

普通投稿须登录且手机号已验证。成功仅在原子持久化后返回 `{ok:true,accepted:true,private:false,receiptId,replyAvailable:true}`。蜜罐或关闭的指南反馈返回 `accepted:false`，不能当作已存储。主要错误：`400` 校验/JSON、`401` 未登录、`403` 未认证/封禁/提交关闭、`429` 限流、`413` 正文超限。尝试限流为每 IP 每分钟 30、全局每分钟 1000；普通有效提交默认每小时 3、每天 15，可由后台规则调整。

新普通反馈受理后为`publicationState=pending`、`replyVisibility=submitter`，须管理员显式批准才可公开。历史公开保留只用于v1迁移，不使新投稿自动公开；客户端不能通过旧`status`、来源字段、处理完成或回复绕过S3规则。

### `POST /feedback-api/report`

请求 `{title,content,contact?,reportUrl?,reportTarget?,resourceRef?,website?}`，服务器强制 report/private，不能通过客户端字段公开。无需登录；如提供登录凭证则必须有效，不降级为匿名。正文至少 5 字，不受普通反馈提交开关、最短长度或指南反馈开关影响。报告独立配额为每 IP 每小时 3、每天 15，旧 `/feedback-api/submit` 的 `type=report|complaint` 复用同一服务与配额。

成功 `{ok:true,accepted:true,private:true,receiptId,replyAvailable}`；只有关联账号时 `replyAvailable=true`，表示可在本人列表查看已保存回复，不表示通知已发送。没有凭裸回执 ID 查询私密内容的公开接口。

```bash
curl -sS https://nkustudy.top/feedback-api/submit \
  -H 'Content-Type: application/json' \
  --data '{"type":"bug","title":"页面问题","content":"这里描述可复现的问题。","contact":"","website":""}'
```

### `GET /visit-api/stats`

成功：`{ "ok":true, "stats": { "total":0, "today":0, "updatedAt":"...", "startedAt":"2026-07-14T16:00:00+08:00" } }`。其中 `total` 同时汇总网站与小程序上报的访问，`startedAt` 与网站页脚使用同一个安全运行起始时间。

```bash
curl -sS https://nkustudy.top/visit-api/stats
```

### `POST /visit-api/hit`

请求：`{ "path":"/courses/某课程" }`；缺省时使用 Referer 或 `/`。服务端只记录固定页面、课程详情模板、评价详情模板或 `/__unknown__`，不记录任意原始 URL；后台和 API 路径不计数。同一 IP+User-Agent 30 分钟内去重。

成功：`{ "ok":true, "stats": { "counted":true, "total":1, "today":1, "updatedAt":"...", "startedAt":"2026-07-14T16:00:00+08:00" } }`。返回的公开统计字段与 `GET /visit-api/stats` 一致；限流为每 IP 每分钟 120、全局每分钟 600，超限返回 `429`。

```bash
curl -sS https://nkustudy.top/visit-api/hit \
  -H 'Content-Type: application/json' \
  --data '{"path":"/courses"}'
```

### `GET /editor-settings`

成功：`{ "ok":true, "data": { "version":1, "updated":"YYYY-MM-DD", "user":{"toolbar":[]}, "admin":{"toolbar":[]} } }`。这是公开的工具栏名称配置，不含密码或管理凭据。

```bash
curl -sS https://nkustudy.top/editor-settings
```

## 管理接口认证

管理端使用**命名账号**（用户名+密码）登录；密码以 scrypt 哈希存储在服务器 SQLite 中，权限点见上文「管理员账号与权限」。Cookie 是随机会话令牌，服务器以 `ADMIN_SECRET_FILE` 中的密钥计算 HMAC 摘要存库；不是自包含的签名身份。密钥不是 API 参数，不应进入网页、小程序、curl 历史或 Git。所有非 GET/HEAD 管理请求（含登录/退出）须通过 `Origin` 与 `X-NKUStudy-Admin-Request: 1` 校验，后者是固定请求来源标记，不是秘密。

首次部署且账号表为空时，自动创建超管 `Shview`：优先使用一次性环境变量 `ADMIN_INITIAL_PASSWORD`（≥10 位），否则生成随机密码写入数据目录 `admin-initial-password.txt`（0600，仅 root/服务账号可读）；该账号首次登录强制改密。旧的共享 `ADMIN_PASSWORD` 登录方式已移除。

### 登录、Cookie 与退出

`POST /admin-api/login` 请求 `{ "username":"...", "password":"..." }`。成功返回 `{ "ok":true, "data":{ "username":"...", "permissions":[...], "mustChangePassword":false } }`，并设置：

```text
Set-Cookie: __Host-nkustudy_admin=<random-token>; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=604800
```

错误：密码错误 `403`；每 IP 5 分钟 5 次、全局 5 分钟 60 次后 `429`；无效/过大 JSON 为 `400`/`413`。

服务入口 `server/admin-server.mjs` 默认绝对期限和空闲期限均为 7 天，分别接受 `ADMIN_SESSION_ABSOLUTE_TTL_MS`、`ADMIN_SESSION_IDLE_TTL_MS`。`AdminSessionStore` 单独实例的默认 8h/30min 不是入口的生效配置。Cookie `Max-Age` 当前固定 604800 秒；实际访问还受服务端期限、撤销和账号状态限制，不能仅由 Cookie 期限判断。

`POST /admin-api/logout` 无需有效会话，返回 `{ "ok":true }` 并以 `Max-Age=0` 清除 Cookie。

建议用 cookie jar，避免复制 token：

```bash
umask 077
read -r -s -p 'Admin password: ' ADMIN_PASSWORD_INPUT; printf '\n'
printf '%s' "$ADMIN_PASSWORD_INPUT" \
  | node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({username:"Shview",password:s})))' \
  | curl -sS -c admin.cookies https://nkustudy.top/admin-api/login \
      -H 'Origin: https://nkustudy.top' -H 'X-NKUStudy-Admin-Request: 1' \
      -H 'Content-Type: application/json' \
      --data-binary @-
unset ADMIN_PASSWORD_INPUT

curl -sS -b admin.cookies https://nkustudy.top/admin-api/session
curl -sS -b admin.cookies -c admin.cookies -X POST https://nkustudy.top/admin-api/logout \
  -H 'Origin: https://nkustudy.top' -H 'X-NKUStudy-Admin-Request: 1' --data '{}'
```

除 login/logout 外，所有 `/admin-api/*` 均要求请求头携带登录所得 Cookie；缺失、令牌未知/过期/撤销或账号已停用返回 `401 {"ok":false,"error":"Unauthorized"}`。`GET /admin-api/session` 成功返回 `{ "ok":true, "data":{ "username":"...", "permissions":[...], "mustChangePassword":false } }`。缺少对应权限点的操作返回 `403`，并计入审计日志。

## 管理接口：课程树与 R2

### Manifest 数据与 CAS

`GET /admin-api/manifest` 返回：

```json
{ "ok":true, "manifest": { "resourceRoot":"...", "courses":[] }, "revision":"sha256-revision" }
```

课程至少需要 `uid`、`id`、`term`、`group`、`title`、`updated`、`basePath`、`sections`。section 至少需要 `title`、`files`；file 至少需要 `title`、`path`。完整替换规则：

- 已有课程必须保留原 `uid`；新课程省略 `uid`，由服务端分配 UUID。
- `deletedCourseUids` 必须与实际删除的 UID 集合完全一致。
- 同一请求不能同时删除已有课程又新增无 UID 课程。
- `basePath` 必须是安全相对路径并以一个 `/` 结尾；file path 必须是安全相对路径。课程路径不得相互重叠，文件公开 key 不得冲突。
- 所有写接口均应使用刚从 GET 返回的 `expectedRevision`。过期 revision 返回 `409` 和 `currentRevision`，不会覆盖他人的变更。

### `POST /admin-api/manifest`

请求：

```json
{ "manifest": {}, "expectedRevision":"...", "deletedCourseUids":[] }
```

成功：`{ok:true, manifest, revision, backup?}`，保存 JSON、执行内容校验和 Astro 构建，再原子切换网站发布目录。已有课程 `basePath` 变化会被拒绝，必须改用 `r2-publish`。主要错误：`400` 缺 revision/删除声明/manifest 校验/不允许的路径变更，`409` CAS 冲突，构建/发布失败通常 `400` 或 `500` 并返回 `rolledBack:true`；发布证明状态不明确时可能 `503`。

```bash
curl -sS -b admin.cookies https://nkustudy.top/admin-api/manifest > manifest-response.json
# 编辑时应从响应中分别取出 manifest 和 revision，并准确计算 deletedCourseUids。
curl -sS -b admin.cookies https://nkustudy.top/admin-api/manifest \
  -H 'Origin: https://nkustudy.top' -H 'X-NKUStudy-Admin-Request: 1' \
  -H 'Content-Type: application/json' \
  --data @manifest-write-body.json
```

### `POST /admin-api/manifest-draft`

请求字段与 manifest 发布相同。成功同为 `{ok:true,manifest,revision,backup?}`，但只保存/校验草稿，不执行 Astro 构建和网站切换。前端在上传文件前用它固化课程和 section。错误规则与 manifest 相同，且不允许已有课程 `basePath` 变化。

### `POST /admin-api/upload`

- 查询参数：`courseId` 为网站 manifest 的可编辑 `course.id`（不是 UUID）；`sectionIndex` 是从 0 开始的 section 下标。
- 正文：`multipart/form-data`；网页使用重复的 `files` 字段。服务端实际接收任意 file part 名称。
- 成功：`{ "ok":true, "files":[{"title":"...","path":"...","size":1,"description":""}] }`。
- 上传直接写入该课程/section 的 R2 前缀，**不会自动更新 manifest**；调用方须把返回的 file 对象并入当前课程树后再发布。
- 错误：课程/section 不存在或 R2 未配置 `400`，文件/数量超限 `413`，R2/解析异常 `500`。

```bash
curl -sS -b admin.cookies -X POST \
  'https://nkustudy.top/admin-api/upload?courseId=<WEBSITE_COURSE_ID>&sectionIndex=0' \
  -H 'Origin: https://nkustudy.top' -H 'X-NKUStudy-Admin-Request: 1' \
  -F 'files=@./example.pdf'
```

### `POST /admin-api/sync-r2`

请求：`{ "courseId":"<website-course-id>", "expectedRevision":"..." }`。按当前课程 `basePath` 列出 R2，合并资源并保留已有说明字段，然后发布网站。成功：`{ok:true,manifest,revision,course}`。主要错误：缺 revision `400`、课程/R2 不存在 `500`、CAS 或同步期间路径变化 `409`。

### `POST /admin-api/sync-r2-all`

请求：`{ "expectedRevision":"..." }`。扫描当前 R2 `resources/` 树，合并已有课程并新增发现的课程，发布网站。成功：`{ok:true,manifest,revision,report}`；`report` 含 merge 统计、`unmatched` 和 `conflicts`。该操作不是“用本地旧 manifest 整份覆盖服务器”。缺 revision `400`、CAS 冲突 `409`、R2/构建异常 `500`。

```bash
curl -sS -b admin.cookies https://nkustudy.top/admin-api/sync-r2-all \
  -H 'Origin: https://nkustudy.top' -H 'X-NKUStudy-Admin-Request: 1' \
  -H 'Content-Type: application/json' \
  --data '{"expectedRevision":"<REVISION>"}'
```

### `POST /admin-api/r2-publish`

用于课程目录移动、资源删除、整课删除等破坏性 R2 变更。请求：

```json
{
  "manifest": {},
  "expectedRevision": "...",
  "deletedCourseUids": [],
  "moves": [
    { "courseUid":"...", "oldBasePath":"大一/分类/旧名", "newBasePath":"大一/分类/新名" }
  ],
  "fileDeletes": [
    { "courseUid":"...", "paths":["往年真题/a.pdf"] }
  ]
}
```

每个实际目录变化、文件删除和课程删除都必须一一精确声明；目标前缀必须为空且不得重叠。服务端先复制并核验目标对象，再 CAS 发布 manifest，最后删除精确旧 key。成功包含 manifest 发布结果，以及 `copied`、`deleted`、`extraSourceObjects`、`unmovedSourceKeys`、`cleanupWarnings` 等事务报告。主要错误：声明或路径不合法 `400`，revision 冲突、目标已存在、源对象缺失或验证失败 `409`，R2/发布错误 `500`。

### 已禁用的旧 R2 接口

以下三个 POST 在通过管理认证后固定返回 `410`，正文被丢弃：

- `/admin-api/delete-r2`
- `/admin-api/delete-r2-course`
- `/admin-api/move-r2-prefix`

响应：`{"ok":false,"error":"Unsafe legacy R2 mutation route is disabled; use /admin-api/r2-publish with manifest CAS."}`。不得作为可用兼容接口调用。

## 管理接口：网站内容和审核

### 通用内容发布协议

以下 GET 均返回 `{ok:true,data,revision}`；对应 POST 均接收 `{data,expectedRevision}`，成功返回 `{ok:true,data,revision}`，保存后执行 Astro 构建和网站原子发布：

| GET/POST 路径 | `data` 结构 |
| --- | --- |
| `/admin-api/home` | `{announcement}`，最多 2000 字符 |
| `/admin-api/footer` | `{enabled,showVisitCount,useRealVisitCount,visitCount,startedAt,copyrightText,copyrightYear,maintainers:[{label,url}]}` |
| `/admin-api/about` | `{title,content}`，分别最多 120/6000 字符 |
| `/admin-api/participate` | `{title,content}`，分别最多 120/8000 字符 |
| `/admin-api/links` | `{title,intro,mutualTitle,recommendedTitle,siteInfoTitle,siteInfo:{name,url,description},links:[{id,type,name,url,description,hidden}]}`；type 仅 `mutual`/`recommended` |

`/admin-api/feedback` 的 GET 仍返回完整反馈 store，但 S3 的单条处置与纯设置保存采用下节协议：单条处置持久化后使公开快照失效，不执行 Astro 构建；反馈设置保存仍触发构建发布。旧整份 POST 仅作为受限制的兼容入口，不能按上述通用内容发布协议增删、重排或批量修改反馈。

主要错误：缺/过期 revision 分别为 `400`/`409`；构建失败会回滚内容并可能返回 `rolledBack:true`；发布状态不明确时可能 `503`。静态目录已切换但 fsync 或旧 release 清理降级时，成功响应保持原有字段并附加 `warnings: string[]`；管理页面会显示这些警告，调用方也应记录并安排运维核查。示例：

```bash
curl -sS -b admin.cookies https://nkustudy.top/admin-api/about
curl -sS -b admin.cookies https://nkustudy.top/admin-api/about \
  -H 'Origin: https://nkustudy.top' -H 'X-NKUStudy-Admin-Request: 1' \
  -H 'Content-Type: application/json' \
  --data '{"data":{"title":"NKUStudy","content":"关于内容"},"expectedRevision":"<REVISION>"}'
```

### S3 评价与反馈单条处置

`GET /admin-api/reviews`、`GET /admin-api/feedback` 返回 `{ok:true,data,revision,itemRevisions,settingsRevision}`。`GET /admin-api/{reviews|feedback}/:id` 返回 `{ok:true,data:item,itemRevision,publicEligible}`。`publicEligible` 是服务器推导的只读字段。

`PATCH /admin-api/feedback/:id` 请求 `{expectedItemRevision,changes}`。仅允许 `handlingStatus`（open/processing/completed/rejected/parked）、`hidden`、`publicationDecision`（approve/reject/revoke）、`reply`（最多 2000 JS 字符，可清空）、`replyVisibility`（submitter/public）。评价 PATCH 仅允许 `hidden/publicationDecision`。原文、类型、ID、归属和所有管理员/时间字段不接受客户端修改。冲突 `409 ITEM_CONFLICT` 返回 `currentItem/currentItemRevision`；成功返回新 item/revision/publicEligible。revision 不受别条、设置或有帮助计数影响。

单条处置以最新显式决定控制公开资格：隐藏、拒绝或撤销可使历史导入内容退出公开出口；取消隐藏不恢复已撤销的资格。修改回复默认转为`submitter`，显式`replyVisibility=public`须条目当时通过公共gate，否则`400 PUBLIC_REPLY_NOT_ALLOWED`。`publicationBlocked`或已知私密/举报条目不能批准公开（`400 PUBLICATION_BLOCKED`），客户端也不能修改导入来源或解除block。

`PATCH /admin-api/feedback/settings` 请求 `{expectedSettingsRevision,changes:{title?,announcement?,rules?}}`；reviews/settings 仅允许 rules。反馈设置保留静态构建、发布证明和回滚事务，条目处置不触发构建。成功 `{ok:true,data:settings,settingsRevision,rulesProvenance}`；冲突 `409 SETTINGS_CONFLICT` 返回 currentSettings/currentSettingsRevision。

新评价保留既有 `moderationRequired` 与 `keywordFilter.enabled` 语义：人工开关启用或已启用的关键词检测命中则 pending，否则自动 approved。自动决定记录实际规则快照/hash、配置来源、服务器时间及系统来源；规则变更与显式人工决定记录真实管理员。旧已公开评价继续通过`legacy_visibility_import`保留可见性，`reviewedBy=system`与`reviewedAt`表示迁移导入，不是历史人工审批回填。

按2026-10-06用户决定，尚未迁移的v1反馈中，旧公开接口实际可见的普通反馈保持公开：原始`status`精确为`approved`/`completed`，未隐藏、未私密、无举报来源且无显式`publicationBlocked`。迁移保留`legacyStatus`，将公开状态设为approved、`privacySource=verified_legacy_feedback_origin`，独立记录`legacyVisibilitySource=legacy_feedback_visibility_import`及`legacyVisibilityImportedAt`；初始`decisionSource=legacy_feedback_visibility_import`，不生成历史`reviewedBy/reviewedAt`。已有公开回复文本与既有时间原样保留，`replyVisibility=public`；缺失时间不补造。服务器后续明确批准时才记录真实`reviewedBy/reviewedAt`与`admin_decision`，并保留独立导入来源。

旧未公开、私密或举报反馈不因本次导入公开；已知投诉举报永久私密。已有schema v2条目不再根据旧`status`或`handlingStatus`导入资格，原v2 blocked条目不会自动解封，PATCH不能修改私密或来源边界。新普通反馈仍待管理员显式批准，回复与处理状态均不授予新的公开资格。

旧两个 POST `{data,expectedRevision}` 仍做整份版本核对，但只适配“一条允许的处置变化”或“仅设置变化”；拒绝增删 ID、原文修改、多条/混合保存和旧 status 隐式批准。UI 已全部使用单条 PATCH；当前没有批量处置、合并或条目删除接口。反馈写需要 content.moderate，评价写需要 content.edit；GET 延续 content.read，依法查询/导出所有有效管理员可用的既有边界不变。

含 UGC 派生结果的 home/courses/review-groups/search-index/search-data 及旧公开列表均 `Cache-Control:no-store`，不复用 304；写入成功主动清快照。部署须同时核对 CDN 缓存规则并清除旧缓存，不能用本机测试声称已经召回浏览器或第三方留存的旧副本。

### `GET /theme.css` 与 `GET/POST/DELETE /admin-api/theme-settings`

`GET /theme.css` 公开输出完整变量集（出厂默认合并当前生效配色 `active`；`:root` 与 `:root[data-theme="dark"]` 两块），缓存 60 秒。管理端 GET 返回 `{active, customDefault}` 两档；POST `{data:{active:{light:{--var:色值},dark:{...}}}}` 更新当前生效配色，`{data:{customDefault:{...}}}` 将方案设为站点默认（此后 DELETE 恢复到该默认）；DELETE 恢复到管理员保存过的默认配色（没有保存过则不做任何回退）。仅接受白名单变量与 `#RRGGBB` / `rgba(r,g,b,a)` 色值，非法条目被丢弃。

### `POST/DELETE /admin-api/site-icon`

POST 以 `image/png` 或 `image/jpeg` 的原始请求体上传站点图标（≤2MB，最长边 ≤4096），服务端用 sharp 生成 512/180/32 三个 PNG 写入运行数据 `site-assets/`（0600）；DELETE 删除覆盖图并回退到构建默认。前台通过 `GET /site-icon/{icon-512,apple-touch-180,favicon-32}.png` 读取，优先覆盖图、无则回退发布树默认（Caddy 需将该前缀转发到本服务）。

### `GET/POST /admin-api/editor-settings`

GET 返回 `{ok:true,data}`，POST 接收 `{data}` 并返回 `{ok:true,data}`；此接口当前**没有 revision/CAS**。`data.user.toolbar` 和 `data.admin.toolbar` 只保留服务端允许的 Vditor 工具名。公开 `/editor-settings` 返回同一已清洗结构。

### `GET /admin-api/visit-stats`

返回 `{ok:true,stats,summary}`，需要 `content.read`。`summary` 为公开 total/today/updatedAt/startedAt；`stats` 还含按天、按页面及近期访客记录（原始 IP、`actorHash/userAgentHash/lastSeen`）。访客按 IP+UA 摘要 30 分钟去重，下一写入清理 24 小时前访客且上限 5000；日统计每个维度最多保留最近 400 个日期键，不等于访客 IP 保存 400 天。旧带 IP 的记录补摘要时不删除 IP。

## 管理接口：备份

### `GET /admin-api/backup`

查询参数 `scope` 默认 `all`，允许 `all`、`manifest`、`reviews`、`feedback`、`pages`、`stats`、`config`。未知值返回 `400`。

`all` 必须先设置至少16位备份加密口令；缺口令返回503。成功返回 `runtime-*.json.enc`，含SQLite全部表及已提交WAL内容、所有现有运行JSON、补写队列、本地日志归档和必要秘密配置的加密快照。加密包包括恢复需要的账户密码哈希及服务配置秘密，应按私密数据保管；口令不能与文件一起公开。文件哈希、SQLite完整性和表数量已经读回校验。课程资源/头像等R2对象字节不在此运行包中。缺必要文件、存储或校验失败不会给出成功下载。

S5 已绑定注销账本时，完整备份含 `deletionLedgerHead` 水位，不包含独立权威账本；缺账本或谱系不一致拒绝打包。历史包不逐份改写。恢复到全新私密目录后保持隔离、撤销会话，须依据独立保存的最新账本重放并核对，不能用备份内水位证明外部最新性或直接启用旧账号。旧包缺历史水位、远端头像及缓存事项不能自动判通过，见 [S5 运维说明](compliance/S5_OPERATIONS.md)。

其余scope仍是 `nkustudy-<scope>-backup-YYYY-MM-DD.json`，顶层明确 `complete:false`；局部配置摘要不含账户凭据。局部导出不能用于声称完整恢复。

```bash
curl -sS -b admin.cookies -OJ 'https://nkustudy.top/admin-api/backup?scope=manifest'
```

### `GET/POST /admin-api/backup-settings`

GET 返回 `{ok:true,data}`。公开设置字段：

```json
{
  "version": 1,
  "updated": "YYYY-MM-DD",
  "autoEnabled": true,
  "dailyTime": "03:20",
  "r2DataBackup": true,
  "r2BackupPrefix": "backups/site-data",
  "webdavEnabled": false,
  "includeSiteData": true,
  "includeServerConfig": true,
  "includeCourseFiles": true,
  "encryptionPasswordConfigured": false,
  "destinations": [
    { "id":"...", "name":"WebDAV", "url":"https://...", "username":"...", "enabled":true, "passwordConfigured":false }
  ]
}
```

POST 接收 `{data}`。新设置的非空加密口令少于16位返回400；完整备份总含站点数据与必要配置，原`includeSiteData/includeServerConfig/r2BackupPrefix`兼容保留但不再允许拆分完整包或指定公开桶前缀。destination 可附带只写字段 `password`、`clearPassword`；顶层可附带 `encryptionPassword`、`clearEncryptionPassword`。密码存入独立的服务器 secret 文件，响应只返回 `*Configured` 布尔值。不要记录或回显密码。成功 `{ok:true,data}`；此接口当前没有 revision/CAS，但服务器串行保存设置。

2026-10-02后续修复：普通设置按允许字段读写；旧文件里的顶层口令、客户端状态标志及destination密码/清除指令不会被读回或作为新输入复用。正常保存会清除普通设置中的旧副本，留空口令保留私密文件里的现有值。此约束在477b191中实现不完整：顶层输入整体写入普通JSON并可能由接口回传，不能以页面密码框为空推断接口不含口令。新修复需部署后生效，不会轮换现有口令或重写历史备份。

### `POST /admin-api/backup-test-webdav`

请求 `{destination:{id?,url,username?,password?}}`。服务器对目标根目录执行 15 秒超时的 `PROPFIND`，若返回 405 则改用 `HEAD`；200/207视为成功，跳转拒绝跟随以避免把凭据转送至其他地址。响应 `{ok,status,statusText,message}`，当 `ok:false` 时 HTTP 为 `400`。缺 URL 或网络异常由统一错误处理返回 `500`。

### `POST /admin-api/backup-run`

正文可为 `{}`。成功返回 `{ok:true,complete:true,manual:true,startedAt,finishedAt,local:{filename,sha256,verified:true},r2:[],webdav:[],errors:[]}`。启用的远端每个必须上传后GET读回并匹配SHA256；WebDAV报告含`id,verified`，可选课程文件另列`courseFiles.verified`计数。任一目标失败返回409和`ok:false,complete:false,error,errors`，已验证的本地副本保留。已有任务运行时409。

R2只允许显式配置的独立私密 `BACKUP_R2_BUCKET`，不得与公开资源桶相同，且维护者须核验后设置 `BACKUP_R2_PRIVATE_CONFIRMED=1`。2026-10-02后续修复使用独立的 `BACKUP_R2_ACCOUNT_ID`、`BACKUP_R2_ACCESS_KEY_ID`、`BACKUP_R2_SECRET_ACCESS_KEY`，不回退到资源客户端或其凭据；Account ID为32位十六进制，对应标准R2端点。缺少配置或上传/读回失败返回`complete:false`，已验证的本地副本保留。自动任务失败一小时后重试。恢复/维护说明见 `docs/compliance/S2_SERVER_ACCEPTANCE.md`。

完整任务已运行时，`POST /admin-api/backup-run`返回409和`code:"BACKUP_BUSY"`；一致性快照暂停准入时为503，捕获阶段竞争为409。上述忙碌拒绝不作为运行故障告警，也不清除原有故障。其余完整备份失败会触发下述运行告警；通知发送结果不改变原备份HTTP结果。

### 通知机器人运行告警用途

`POST /admin-api/notify-bots`的`purposes`支持`moderation`、`digest`及新增`ops`。仅明确启用且包含`ops`的机器人接收应用日志/完整备份故障卡片，旧配置不自动订阅。通知只含固定故障类别、UTC时间和建议；HTTP非2xx或上游业务失败均不能计为发送成功。成功后同类故障30分钟冷却，失败至少一分钟重试，恢复后新故障重新告警；状态不跨重启保存。后台表单支持新用途的保存、回填、重置和展示。

`POST /admin-api/notify-test`仍只向选择的单个机器人发送测试，需原`backup.manage`权限并留管理审计；此接口不会主动破坏日志或备份。生产实际送达、入口故障及磁盘外部监控不由本地测试代验。

取运行快照期间拒绝新请求503并等待在途请求结束，短暂暂停是为了取得一致时间点；在途超时或文件故障使备份失败，不用半成品冒充完整。

```bash
curl -sS -b admin.cookies -X POST https://nkustudy.top/admin-api/backup-run \
  -H 'Origin: https://nkustudy.top' -H 'X-NKUStudy-Admin-Request: 1' \
  -H 'Content-Type: application/json' --data '{}'
```

## 字段白名单和隐私边界

公共 v1 DTO 逐字段构造，不直接展开 manifest、评价或反馈原始记录。公共接口不会暴露：

- `basePath`、文件相对 `path`、manifest `resourceRoot`、`source`、`repository`、本机/Windows 路径；
- R2 账号、bucket secret、管理密码、签名密钥、备份密码；
- contributors/管理元数据、审核标记、IP/actor hash、User-Agent、反馈联系方式；
- 管理接口、内部 revision、备份或发布路径。

标签、term、group（例如“通识选修课”）、assessment 和评价内容直接来自服务器；manifest/课程的 `hiddenMetaTags` 和服务端禁止展示项会从公开 facets/标签中过滤。资源仅返回已校验的 HTTPS `download_url`，不返回内部拼接字段。

## 当前明确未开放的接口

下列接口在当前版本中未注册，调用返回 `404`，其他开发者不得依赖或自行假设兼容行为：

- 旧手机号接口设想 `/api/v1/auth/phone`；实际入口是已注册的 `/api/v1/auth/phone-verify`；
- 投稿和举报：`/api/v1/resource-submissions`、`/api/v1/resource-submissions/mine`、`/api/v1/reports`、`/api/v1/resources/:id/reports`；
- 旧客户端设想的 `/api/v1/resources/:id`、`/api/v1/courses/:id/reviews`；
- `/api/v1` 下任何管理接口。

浏览课程、资料和公开评价不需要登录。管理工作继续只通过网页端 `/admin-api/*`，不会暴露给小程序。

## 文档一致性检查

路由变更后运行：

```bash
npm run check:api-docs
```

脚本会按测试覆盖的路由写法，从当前公共和管理 router 提取直接路径比较、路径数组及受支持的动态正则路由，并与本页“接口总表”双向比较。它能发现这些受支持写法中的接口增删漂移，但不是通用 JavaScript 路由分析器；采用新的注册写法时必须先扩展提取器测试。字段、权限、状态码和业务语义仍应同步检查服务层、DTO、集成测试与前端调用。


## S2 日志查询增补（2026-10-01）

`GET /admin-api/audit` 对全部有效管理员可用；未登录或停用账号401。默认管理员事件：`username`、`action`、精确`target`（如`review:ID`、`feedback:ID`、`user:ID`）、`from/to`（毫秒时间戳）、`page/page_size`。`kind=user`选用户事件，支持`user_id`、`target_type/target_id`、`action`、`from/to`及分页。最大每页1000，响应`data:{items,total,page,page_size}`；新查询将SQLite和归档合并去重，损坏归档导致请求失败而不是静默返回空结果。

响应含`logHealth`：user/admin/law各自的`ok,pending,inFlight,error,maintenanceError`。失败持久队列不可删除；自动30秒尝试补写。用户结果`interrupted`和管理员`status:0`表示中断后实际结果需核对；结果不是正常业务失败或成功的断言。

S2时期的`law-export`仅包含所选日志页；以下S4候选已改为同一范围完整导出。S4尚未部署，不能把源码行为写成生产回执。查询条件中的手机号/openid不在审计里重复存原值；失败条件记服务端HMAC，成功归于精确解析的对象ID，成功/失败/拒绝均留痕。

## S4 管理员查询与完整导出（2026-10-07候选）

三个`/admin-api/law-*`入口均要求有效管理员Cookie。按C-08不要求额外`law.manage`角色，导航与权限注册表一致；未登录、普通用户、停用、过期及撤销管理员会话拒绝。备份及其他管理功能权限不因此改变。相关响应均`Cache-Control:no-store`。

### `GET /admin-api/law-query`

`type=account`（默认）用`value`精确匹配用户ID、11位手机号或openid；`type=review|feedback`用`id`精确匹配内容ID。账号DTO不包含密码哈希、会话或令牌。账号查询关联该用户的内容及其处置审计；不会通过模糊匹配`1`把`10`的内容带入。已删除内容可依据留存的成功投稿事件恢复ID关联，不能凭空重建已经缺失的原文或作者映射；限制见响应`scopeNotes`。

`from/to`为非负毫秒或带时区ISO时间（含端点），默认0至本次收集时间；**只筛安全日志和管理员审计，账号和内容是关联上下文**。`action`精确筛安全日志动作，`audit_action`精确筛管理员审计动作。可选`reference`为1至80位字母、数字、点、下划线、冒号或横线，用于内部登记关联，不是导出审批门槛。

分页分别为`review_page/feedback_page/content_page_size`、`log_page/log_page_size`、`audit_page/audit_page_size`；默认每页100，最大1000，`audit_page_size`缺省时兼容`log_page_size`。响应`{ok:true,audit_event_id,data}`；data含`query/range/account/reviews/feedback/security_logs/admin_audit/counts/complete/snapshot`，以及`reviews_pagination/feedback_pagination/log_pagination/audit_pagination`。分页元数据有`total/page/page_size/returned/total_pages/has_more/truncated`，总数是所选范围全部记录数，`complete=false`表示本页响应并未包含全部记录。

### `GET /admin-api/law-export`

使用相同标识、时间及动作筛选，**忽略分页参数**，同步收集各源一次后导出全量关联结果；不循环下载变化中的多页。正文包含查询全部字段，并增加`exported_at/exported_by/audit_event_id`、`complete:true`、计数、范围和上限说明。`snapshot.atomic_across_sources=false`明确这不是JSON与SQLite多个来源之间的原子快照；要求固定共同时间点时须执行受控停写流程。

每类超过50000条或最终JSON超过32 MiB时返回`413 LAW_EXPORT_TOO_LARGE`，须缩小日志范围或按内容ID导出，不返回带附件头的半包。找不到对象404，非法筛选400，坏归档/待恢复日志503；错误没有下载附件头。成功`Content-Disposition:attachment`与`X-Content-SHA256`对应实际下载字节；管理员审计和调取日志使用相同`event_id`，记录对象、筛选摘要、数量、字节数、哈希和结果，不复制原文/手机号/openid。生成/下载记录不表示已经对外发送或已被接收。

两份日志必须先接受证据才发送结果。调取日志原事件为`outcome:prepared/status:0/intendedStatus`，管理员审计的`delivery:response_ready`表示响应准备就绪，均不是下载或接收证明。任何日志结果写入失败返回503、无附件；可写存储记录失败。若原记录已不可变或原队列纠正也失败，追加新`event_id`的503并以`relatedEventId`关联原请求；复核时必须一起看关联事件，不能单看原200。连续故障有界重试，不保证不可写存储凭空保存失败详情；待恢复意图/准备记录不是成功，须恢复后核对。

### `GET /admin-api/law-logs`

真正读取SQLite及归档调取历史，支持`actor/type/exported/from/to/page/page_size`。actor及type精确匹配，exported接受true/false（兼容1/0）；时间规则同上，默认50条，最大1000。响应`{ok:true,items,total,page,page_size,returned,total_pages,has_more,truncated,filters}`。读取历史本身写管理员审计，但不新增同一调取历史列表里的假查询。旧无校验历史归档仍可读取；损坏或待恢复时明确失败，不静默当成空列表。

`exported`只区分导出请求和查询请求，不代表导出成功；结果以摘要及关联管理员审计为准。新事件可能是一条准备记录加一条关联失败补偿，不能按记录行数直接当成独立请求数量。

外部交付的登记、范围复核、文件哈希、交付对象/方式及接收确认见[S4受控交付操作单](compliance/S4_CONTROLLED_DELIVERY.md)。本轮只使用合成记录演练，没有读取或发送真实生产个人资料。

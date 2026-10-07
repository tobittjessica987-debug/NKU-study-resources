# NKUStudy · 南开课程资料导航

<div align="center">

**[https://nkustudy.top](https://nkustudy.top)** · 课程资料共建，非南开大学官方平台

网站 · 管理后台 · 小程序公共 API · R2 资源分发

</div>

---

> 生产内容、评价、反馈、凭据、备份、SQLite 数据库与课程资源文件一律不入 Git；
> 网站管理后台是唯一的内容管理入口；小程序 API 只暴露公共/用户操作，永不暴露 `/admin-api/*`。

本文描述当前仓库候选的能力。S3 审核、S4 查询导出和 S5 注销候选尚未部署生产；本地证据与未验事项见 [整改台账](docs/compliance/SECURITY_ASSESSMENT_READINESS.md)、[S4 验收](docs/compliance/S4_ACCEPTANCE.md) 和 [S5 验收](docs/compliance/S5_ACCEPTANCE.md)，不能据此宣称全部整改或生产验收通过。正式政策及申报使用已确认的公司运营主体；公司全称、地址和专用联系渠道尚未在本批材料核实，须由负责人确认，不能用“学生共建”替代运营主体。

## 这是什么

NKUStudy 是面向南开学生的课程资料导航与选课参考平台，整合课程信息、学习资料、课程与教师评价：

- **公开网站**（Astro 静态站）：课程库、资料下载、评价浏览、选课指南——免登录直接用
- **管理后台**（`/admin/`）：课程资源管理、评价/反馈审核、内容发布——多账号 + 权限分级 + 操作审计
- **微信小程序公共 API**（`/api/v1`）：微信身份登录、收藏、评价提交——配套小程序仓库 [mzk-C4/NKU-study-wxapp](https://github.com/mzk-C4/NKU-study-wxapp)
- **资源分发**：课程文件存 Cloudflare R2，经 `resources.nkustudy.top`（Cloudflare CDN）下载

课程、评价与访问数量以运行数据和当前公开结果为准；仓库合成夹具不代表生产数量。

## 架构

```
访客/小程序
   │ HTTPS
   ▼
Caddy（TLS / 反代 / HTTP→HTTPS）
   ├─ 静态站 ──────────► /var/www/nkustudy-publish（原子发布的多版本 release）
   └─ 动态服务 ────────► Node 22 · server/admin-server.mjs（仅监听 127.0.0.1:8787）
        ├─ /api/v1/*        小程序公共 API（缓存 + ETag + 限流）
        ├─ /review-api/* 等 网站公开读写（评价/反馈/访问统计）
        └─ /admin-api/*     管理接口（Cookie 会话 + CSRF 源校验 + 权限点）
   存储
    ├─ 运行数据 JSON（课程 manifest/评价/反馈/页面内容）─ /var/lib/nkustudy/json
    ├─ SQLite（会话/限流/小程序用户/收藏/审计）─────── /var/lib/nkustudy/miniprogram.sqlite
    ├─ Cloudflare R2 公开资源桶（课程文件/内容图片/头像）
    └─ 私密加密备份与日志归档（本地受限目录；独立私密 R2/WebDAV 依实际配置启用）
```

- **发布模型**：每个版本部署到独立 release 目录（`/opt/nkustudy-releases/<日期-提交>`），systemd 工作目录原子切换，保留全部历史可回滚；静态站同样按 release 发布、软链切换
- **内容变更**：管理端保存 → JSON 原子写入 → 触发 Astro 重新构建 → 静态 release 原子上线（带发布日志与崩溃恢复）
- **R2 变更**：走 manifest CAS（乐观锁）+ 复制后校验 + 事务清理的保守事务模型

## 管理后台能力

- **多账号权限**：账号+密码（scrypt），11 个现有权限点、6 角色预设（super_admin / service_admin / ai_admin / content_admin / reviewer / viewer），保护最后一个启用的账号管理员。服务入口默认管理员会话绝对期限和空闲期限均为 7 天，可由环境变量分别设置；类自身的 8h/30min 默认值不是服务入口的生效值。当前 Cookie 为 `__Host-nkustudy_admin`，详见 [认证契约](docs/API.md#管理接口认证)
- **内容管理**：课程资源（R2 同步/事务发布）、评价/反馈单条 CAS 处置、首页/关于/参与/友链/页脚/捐助/隐私等页面内容。课程和页面设置保存会构建并原子发布；评价/反馈单条处置直接使公开快照失效，不触发构建。Markdown 编辑器（vditor）支持 R2 内容图片及同归属未引用图片清理
- **举报处置**：违法举报与内容投诉独立页签（与普通反馈分离），状态机处置 + 处理人/时间留痕；举报内容永不公开展示
- **捐助与支付**：捐助页内容/预设金额可配；微信支付 v3（JSAPI 小程序 + Native 网页扫码）完整下单/回调验签/解密/幂等入账，捐赠记录支付成功自动追加公开表，统计支持全量订单检索/筛选/分页；商户密钥仅存服务器（0600，接口只回掩码）
- **查询与导出（内部）**：所有有效管理员均可按账号/评价/反馈 ID 精确查询、筛选、分页和完整导出，成功、失败、拒绝留痕。`law.manage` 保留为兼容权限点，不是这些入口的额外门槛；对外提供资料另按 [受控交付规程](docs/SECURITY_COMPLIANCE_SOP.md) 核验、最小化、批准及接收确认
- **审计日志**：管理员请求、用户关键事件及调取记录写入 SQLite，故障采用持久补写队列；超量先私密归档再清热表，查询包含归档。现有日志维护采用 400 天工程配置，实际生产留存与恢复以回执核验
- **内容规则**：课程评价在 `moderationRequired=true` 或命中已启用检测规则时待审，其余按规则自动公开并记录依据；新普通反馈默认待审，须显式批准才公开。私密投诉永不公开；历史实际公开的内容和公开回复保留原可见性，事后仍可下架。当前提供单条处置，批量处置、合并和条目删除尚未交付
- **飞书通知**：多机器人（独立 webhook+签名+用途），新评价/新反馈实时卡片，每日汇总（可选启用），单机定向测试
- **小程序用户管理**：列表/搜索/排序、登录统计、手机号认证状态、黑名单（封禁账号在下一次鉴权时拒绝）。手机号认证用于站内追溯，不能等同自然人的法律身份核验
- **访问统计**：7/30/90 天折线图（鼠标追踪悬浮）、按类别汇总（网页/小程序）、页面明细（解码课程名）、访客 IP（30 分钟去重）
- **备份**：可配置每日自动与手动；完整运行包包含 SQLite、运行 JSON、队列、归档及必要配置并加密，不含课程文件/头像对象字节。远端上传须读回校验且只使用私密目标；私密 R2、实际口令保管及最终候选生产恢复仍待对应回执
- **账号注销**：按已确认的保留内容方案，停用账号并清登录身份、收藏及业务关联；原公开状态保持，私密投诉继续私密。受限日志、最小注销账本和旧加密备份有保留与恢复例外，正文自述信息及历史缓存不保证自动消除，见 [S5 策略](docs/compliance/S5_POLICY.md)

## 公共 API 概览（完整契约见 [docs/API.md](docs/API.md)）

| 分类 | 端点 |
|---|---|
| 课程/资料 | `GET /api/v1/home` · `courses` · `courses/{id}` · `courses/{id}/resources` · `search-index` · `search-data`（前端本地分级搜索）· `guides` |
| 内容页 | `GET /api/v1/about` · `donate`（捐助页内容与预设金额） |
| 评价 | `GET /api/v1/review-groups[/{key}]` · `POST /api/v1/reviews`（登录+手机号认证，按配置待审或自动公开） |
| 登录 | `POST /api/v1/auth/wechat`（wx.login code → 默认 30 天 Bearer token）· `auth/phone-verify`（微信手机号认证）· `web-register` / `web-login`（默认 30 天网页会话）· `me` · `me/profile` · `auth/logout` |
| 个人 | `GET /me/favorites` · `POST/DELETE /favorites` · `GET /me/reviews` |
| 捐助 | `POST /api/v1/donate/pay`（小程序 JSAPI）· `donate/pay-native`（网页扫码）· `donate/order-status`（轮询）· 回调 `donate/notify` |
| 网站读写 | `GET/POST /review-api/*`（评价）· `feedback-api/submit`（新普通反馈待审）· `feedback-api/report`（匿名私密投诉）· `visit-api/stats` / `hit`（访问统计，含 `startedAt`） |
| 注销 | `POST /api/v1/me/delete-account`（200 确认必要清理完成；202 仅受理并停用、清理待重试） |

v1 成功响应 `{code:0,data}`，失败含 `code/message`；旧接口使用 `{ok,...}`。只有可缓存公共 GET 使用 ETag/304；评价派生内容和身份接口为 `no-store`。普通用户 DTO 不含完整 OpenID、原手机号或密码摘要；服务端保存 OpenID/手机号，有效管理员的受控查询导出可能包含原始身份信息。

## 仓库结构

```
server/          Node 服务（admin-server + 各服务模块：账号/会话/审计/认证/收藏/通知/限流/发布…）
src/             Astro 站点（页面/组件/样式）+ admin.astro 管理界面
scripts/         校验/构建/迁移/冒烟脚本（含 API 文档一致性检查）
docs/            API.md（权威路由契约）· DEPLOYMENT.md · SECURITY_COMPLIANCE_SOP.md · data-schema.md · compliance/
test/            单元和合成集成测试（含身份、审核、日志、导出、注销/恢复和微信支付回调）
```

## 开发

```bash
npm ci                 # 安装依赖
npm test               # Node 内置 test runner，数量以当次输出为准
npm run build:fixtures # 用固定数据构建验证（本地无需生产数据）
npm run check:api-docs # API 文档与路由注册一致性检查
npm run dev            # Astro 开发服务器
```

- 生产环境受 fail-closed 预检保护（`DATA_DIR` 0700+哨兵、密钥 0600、`PUBLIC_DIR` 受管软链），本地开发自动放宽
- **永远不要**把本地 `src/data` 覆盖到生产；生产数据只经管理后台或迁移脚本变更（见 `docs/data-schema.md`）
- 提交前跑 `npm test`；CI（GitHub Actions）执行同一套检查

## 部署要点（详见 docs/DEPLOYMENT.md）

```bash
# 摘要：打包提交 → 服务器解压到 /opt/nkustudy-releases/<date-hash> → npm ci → npm test
# → 切换 systemd WorkingDirectory → restart → 管理端发布触发静态重建
```

关键环境变量：`DATA_DIR` `STATE_DB_PATH` `ADMIN_SECRET_FILE` `ADMIN_ORIGIN`（必填）、`WECHAT_APPID/WECHAT_APPSECRET`（微信登录）、`R2_*`（公开资源）、`BACKUP_R2_*`（独立私密备份）、`DELETION_LEDGER_DIR`（独立注销账本）、`TRUSTED_PROXIES`（生产必填，按实际反代拓扑配置）。具体部署和注销恢复步骤见 [部署说明](docs/DEPLOYMENT.md) 与 [S5 运维说明](docs/compliance/S5_OPERATIONS.md)。

## 数据与安全边界

- 账号数据包含内部 ID、OpenID、昵称、头像、可选邮箱、手机号及认证时间、密码摘要、收藏和登录元数据；内容记录还可能包含联系方式和账号关联。公开 DTO 使用白名单，正文中的自述信息不因此自动消除。
- 限流用 HMAC 摘要；安全/管理员日志保存原始来源 IP 和 UA，访问统计近期访客也保存原始 IP、摘要及时间。摘要不等于彻底匿名；IP 或手机号认证不等于已核验自然人身份。完整清单见 [数据说明](docs/data-schema.md)。
- 管理员 Cookie 为随机令牌，服务端以 HMAC 摘要存库；非 GET/HEAD 管理请求还须来源及自定义请求头校验。历史测试和本地合成验收不能代替最终候选的生产验证。

## 整改与运营待办

S2 有既有生产回执，S3/S4/S5 为本地候选，最新范围以逐项验收记录为准。现有用户、管理员、调取日志维护及 Caddy 入口模板采用 400 天配置（模板 `9600h`），这不是所有数据的统一法定期限；生产启用、容量、归档、实际保留和恢复须核验。运营主体公开信息、真实投诉值守/升级渠道、分类保留策略与对外交付执行由负责人落实，见 [内部规程](docs/SECURITY_COMPLIANCE_SOP.md)。

## 相关仓库

- 小程序：[mzk-C4/NKU-study-wxapp](https://github.com/mzk-C4/NKU-study-wxapp)（原生微信小程序，对接本仓库 `/api/v1`）

## 声明

课程资料共建平台，非南开大学官方平台；内容仅供参考，选课与考核信息请以教务系统为准。

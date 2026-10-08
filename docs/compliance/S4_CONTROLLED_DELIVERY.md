# S4 对外资料受控交付操作单

> 2026-10-07，本地候选操作规程，覆盖 LAW-14/LAW-15/GOV-16 的交付流程部分。C-08 的所有有效管理员均可内部查询/导出；下文批准针对对外提供资料，不是导出按钮审批。本地记录校验和合成演练不证明真实主体核验、生产部署、真实取数、组织值守或外部送达已经执行。

本操作单不新增法条解释、法定期限、人员姓名或审批平台。真实文书、人员/账号标识、原文、日志与文件保存在现有受控私密档案；仓库仅保留合成例子、规程和脱敏验收结果。

## 1. 登记、核验和决定

1. 建立唯一请求编号，记录收到时间（ISO 8601，含时区）、登记角色、请求方提供的主体、文书、经办人、依据和拟接收对象。登记材料引用，不把秘密或全文塞进普通审计。
2. 负责人按真实材料和可确认的联系渠道分别核验主体、文书、经办人及依据；记录核验角色、时间、方法/材料引用和四项结果。经办或接收对象变化须重新核验；不凭来信标题、源 IP 或登录账号替代核验。
3. 填写请求范围与最小批准范围：精确账号/内容选择条件、时间上下界及是否包含边界、时区、站点、数据来源、需要的字段；说明时间限制具体作用于哪类记录。避免模糊匹配 ID、无关用户、整库、所有日志或包含凭据的配置文件。
4. 记录负责人决定、时间、理由、批准范围及交付对象。主体/文书/经办/依据未确认，或超出可提供范围且不能合理缩小的请求，记录拒绝或待补正；拒绝记录不得同时声称已经交付。必要补正或拒绝通知由实际负责人另按现有流程安排，本次工具不会发送消息。

软件内部查询能力保持 C-08。负责人和执行管理员可以是同一实际人员；规程不强制双人批准，也不要求分享管理员凭据。登记的角色/账号引用与真实私密材料的映射由组织保管。

## 2. 应用资料的受控取数与复核

1. 在受控工作环境用有效管理员查询账号/内容和相关日志，按精确目标及允许的时间/action等筛选。未找到的结果写「未找到」，查询失败/拒绝/结果未知分别记录，不把失败的空数组写成没有资料。
2. 导出下载后私下保存元数据与查询/导出事件引用。S4 后端契约的 `audit_event_id` 与管理员审计、调取记录中的事件关联；记录 `exported_at/exported_by`、`generatedAt`、`query`、`range`、各类 `counts`、`complete` 和 `snapshot`。普通内部查询无需对外批准编号；对外交付登记可把实际请求编号作为引用，不伪造真实文书编号。
3. **时间含义：** `range` 的起止边界包含端点（`inclusive:true`）；API 的时间筛选作用于 `security_logs` 和 `admin_audit`，账号、评价及反馈是精确目标关联的上下文，不因此被限制到该日志时间窗。若请求还限制内容发布时间或只要部分字段，执行受控最小化并记录处理依据，不能把整个账号关联导出直接称为已符合该时间/字段范围。
4. **完备性含义：** `complete:true` 是此次应用查询范围内的收集结果；`snapshot.scope:'synchronous_collection'` 且 `atomic_across_sources:false` 不证明数据库与 JSON 跨来源冻结快照，也不包含网络入口日志。核对查询条件、每类数量、已知空档、恢复队列与来源状态。每类超过 50,000 条或 JSON 超过 32 MiB 的导出应失败为 413；未产生完整文件时停止，按可解释的时间/目标范围拆分，每份记录审计及哈希，避免重叠遗漏。不能把失败或人为抽样称完整导出。
5. 对实际下载字节计算 SHA-256 和字节数，对照响应 `X-Content-SHA256` 及同事件导出审计中的哈希/字节信息；JSON 正文不能包含自身最终哈希。原始下载存为受控源副本。最终交付文件若做字段裁剪、相关行提取或格式变换，记录源→最终文件的处理引用、两份哈希/字节数与最终记录数，再次复核；不得沿用变换前的哈希。

对已经私密保存的文件，可以由操作人在本机执行以下只读校验命令（路径仅示意，不能将真实文件提供给本轮演练）：

```sh
shasum -a 256 '/受控私密目录/最终交付文件.json'
wc -c < '/受控私密目录/最终交付文件.json'
```

哈希只验证字节一致，不能证明内容真实、范围合法或送达正确对象。下载头与审计缺失或不同、文件意外变化、数量不符时暂停交付，保留事实，不手填「一致」。

审计中的`prepared`、`response_ready`及调取记录的`exported`不能证明本机下载完成或对外送达：前两者表示响应准备阶段，后者只标识导出请求。发生审计写入故障时响应为503；补偿事件使用新ID并通过`relatedEventId`关联原事件，须合并查看，不能只依据原200判成功。连续写入故障可能只留下待恢复意图或一侧证据；此时保持未知/失败，待存储恢复后核对，不手工补造成功记录。

## 3. 网络入口日志的受控运维取数

网络入口日志保留在 S2 的私密 Caddy 目录及私密归档，不要求复制到后台 UI，也不能作为账号内部导出的隐藏附加资料全量提供。

1. 负责人在批准范围写清站点主机名、含时区的精确时间窗、必要路径/方法/状态/可确认网络来源条件、所需字段及关联依据。源 IP 不是自然人身份；同 IP 的其他用户不能因此全带入某账号的资料。无法可靠对应账号时登记「关联未证实」，不能补造关联。
2. 运维按实际部署拓扑核对日志路径、Caddy/代理版本与可信代理设置。取数前登记原始文件/归档回执的私密引用、覆盖时间和字节哈希；复制到私密工作目录（目录 0700、文件 0600），检查已关闭轮转文件的 S2 `.receipt.json` 哈希读回。需要活动日志时取得当次受控副本，记录采集时刻和边界；不截断、改写或删除原日志。
3. 核对被选文件覆盖请求全窗、各主机实际启用的日志、压缩轮转文件是否都能读取、重复副本/重叠和已知日志空档。S2 `archive-entry-logs.mjs` 只处理已关闭轮转且有按年龄到期行为，不能为了某次请求对历史目录盲目重跑、清理或把它当查询工具。长期保留/已部署回执不能单独证明此次时间窗完整。
4. 从明确选中的快照逐行解析 `ts`（Unix 秒，保留小数精度），按已批准的精确 `request.host` 和时间窗匹配；跨主站/www/资源站需分别登记实际主机名和覆盖情况。仅投影批准字段，再核对必要的路径/方法/状态及网络条件，记录命中数、最终行数、不可得字段和范围复核。解析失败、未知时区或遗漏文件时停止或按明确的部分结果流程处理，不跳过坏行后称完整。
5. S2 文件去掉查询串和请求/响应头，仅额外保留 UA；这些被删除的值不可恢复，不能为补取而开启 `log_credentials`、第二份未脱敏日志、全头/全 URL 记录。`remote_ip/remote_port` 是直接连接对端；有 CDN 时通常属于 CDN，不能冒充最终用户端口。`client_ip` 只有当时可信代理配置和来源可核对时解释为客户端来源。UA、路径及其他可得字段仍须审查是否夹带无关资料或凭据。
6. 最终网络资料仅限复核后的文件，另计算 SHA-256/字节/行数，登记运维操作与来源档案引用、拓扑说明、脱敏边界、不可得字段、空档与非原子采集限制。不要将整份原始日志、秘密、源档案目录或配置文件作为交付附件。

下面是**单个已选快照**的离线预筛选示例，只按主机与时间选择并投影 S2 可得字段。它不是账号身份匹配、最小范围批准、全窗完备性证明或自动交付；多文件、网络条件和批准字段仍按上文逐项复核。命令读取操作者明确给出的快照，拒绝覆盖既有输出；示例现在不执行，也不读取生产。

```sh
python3 - '/受控私密目录/已选日志快照.jsonl.gz' '/受控私密目录/待复核摘录.jsonl' '实际主机名' '2026-10-07T10:00:00+08:00' '2026-10-07T10:04:59+08:00' <<'PY'
import datetime, decimal, gzip, json, os, re, sys
source, target, host, start, end = sys.argv[1:]
def epoch(text):
    if re.search(r'\.\d{7,}', text):
        raise ValueError('time window exceeds supported microsecond precision')
    value = datetime.datetime.fromisoformat(text.replace('Z', '+00:00'))
    if value.utcoffset() is None:
        raise ValueError('timezone required')
    utc = value.astimezone(datetime.timezone.utc)
    delta = utc - datetime.datetime(1970, 1, 1, tzinfo=datetime.timezone.utc)
    return decimal.Decimal(delta.days * 86400 + delta.seconds) + decimal.Decimal(delta.microseconds) / 1000000
low, high = epoch(start), epoch(end)
if low > high:
    raise ValueError('invalid time range')
read = gzip.open if source.endswith('.gz') else open
selected = []
with read(source, 'rt', encoding='utf-8') as rows:
    for line in rows:
        if not line.strip():
            continue
        row = json.loads(line, parse_float=decimal.Decimal)
        stamp, request = row.get('ts'), row.get('request')
        if not isinstance(stamp, (int, decimal.Decimal)) or isinstance(stamp, bool) or not isinstance(request, dict):
            raise ValueError('invalid entry log row')
        if low <= stamp <= high and request.get('host') == host:
            item = {key: row[key] for key in ['ts', 'status', 'user_agent', 'source_port_kind'] if key in row}
            item['ts'] = str(stamp)  # Preserve the source precision; Unix seconds.
            item['request'] = {key: request[key] for key in ['host', 'method', 'uri', 'remote_ip', 'remote_port', 'client_ip'] if key in request}
            if 'uri' in item['request']:
                if not isinstance(item['request']['uri'], str):
                    raise ValueError('invalid request path')
                item['request']['uri'] = item['request']['uri'].split('?', 1)[0]
            selected.append(json.dumps(item, ensure_ascii=False, allow_nan=False))
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w', encoding='utf-8') as output:
    for line in selected:
        output.write(line + '\n')
print(json.dumps({'selectedRows': len(selected), 'completeWindowVerified': False}))
PY
```

上述示例主机名须与 `request.host` 完全相同（包括实际记录中的端口）；不会按子串或账号 ID 模糊查询。`ts` 在摘录中存为十进制字符串以保留原始精度，窗口输入最多支持六位小数的微秒精度；更细的窗口会拒绝，须另以保持原精度的受控方法取数，不能舍入扩大范围。退出失败或输出未完整写入时不交付；摘录仍需受控复核并按批准字段裁剪。Windows 上需按组织现有流程核对 ACL，不能以 POSIX 模式位声称已受限。

## 4. 交付、确认与归档

1. 负责人在交付前确认最终范围、完整/部分状态、已知缺口、文件哈希及接收主体/经办人。部分结果必须明确其限制及继续补取安排，单独记录批准与告知；不可把部分结果改名为完整。接收对象改变时重新核验与记录决定。
2. 仅用已经确认的受控方式交付，登记时间、操作角色、接收主体/经办、方式和传递凭证引用。不得使用公开资源桶、公开下载链接、公共聊天/PR、通知 webhook 或邮件群发代替受控交付。若受控方式使用加密，秘密通过既有独立安全渠道安排，不写入登记或命令行。
3. 接收方核对最终文件 SHA-256，并通过已经确认的渠道确认接收；保存接收角色/时间/哈希/确认凭证引用。未送达、无确认、哈希不符或误送时记录实际状态并升级负责人，不能用浏览器下载成功或脚本退出 0 代替接收确认。
4. 私密归档包含登记、核验材料、范围和批准/拒绝、审计事件、来源/变换记录、文件哈希/字节/行数、交付与接收确认、限制和后续事项。登记保管人、受限访问及适用保留策略引用；期限未定须负责人后续安排，不由脚本猜测期限或执行删除。

## 5. 离线登记 JSON 与校验器

`scripts/verify-controlled-delivery.mjs` 是小型离线一致性校验器。必须给出登记文件路径，或明确选择内置合成例子；没有默认生产路径、不读取 DATA_DIR/SQLite、不会读取登记引用的导出文件/文书/日志、不会计算真实文件哈希、不会包装、发送或上传资料，不接通知/R2，不改变查询/导出权限。

| 字段 | 记录内容 |
|---|---|
| `schemaVersion`, `synthetic` | 当前版本 1；明确是合成记录还是操作者登记 |
| `request` | 请求引用、登记时间、主体/文书/经办/依据引用、原请求 `scope` |
| `verification` | 核验时间/角色及 `subject/document/agent/basis` 四项布尔结果 |
| `decision` | 决定时间/角色、`approve/refuse`、理由引用；批准有 `approvedScope`，拒绝有 `refusalCode` |
| `scope` | `from/to` 含时区、`inclusive:true`、IANA `timeZone`、精确 `sites/selectors/fields/sources` 与 `timeAppliesTo` |
| `collection` | 取数时间/角色、查询及导出审计引用、来源引用、实际最终范围、源 `exportEvidence`、最终 `artifact`、变换引用及完备性 |
| `completeness` | `complete/partial`、所声明范围的命中/最终条数、是否截断、已知缺口；部分结果另有交付前的 `acceptance` 时间/角色/说明引用 |
| `artifact` | 最终 `sha256/bytes/recordCount/storageRef` 与 `credentialsExcluded:true` 的复核声明 |
| `delivery`, `receipt` | 同一主体/经办、方式与传递引用、最终哈希、接收确认时间/引用；部分结果的 `limitationsRef` 对应接受限制记录 |
| `archive` | 归档时间/保管角色/记录引用、`restricted:true`、保留策略引用 |

来源标识为 `account/reviews/feedback/security_logs/admin_audit/entry_logs`；选择条件为 `{kind,value}`，支持 `user_id/review_id/feedback_id/request_id/source_ip`，值为精确字符串，不用前缀/子串匹配。源 IP 条件只是已批准的网络选择条件，不能证明身份。`timeAppliesTo` 可含 `security_logs/admin_audit/entry_logs`，必须属于该范围的来源；不能删除已承诺的时间筛选而保留同一来源。字段是统一登记清单，真实多来源的逐字段映射另保存在范围复核材料。

最小化后的实际范围必须是批准范围的子集，批准范围必须是请求范围的子集。若被核验文书明确允许或要求修订原范围，应先记录新的有效请求范围和重新决定，不能通过改校验器绕过。源文件与最终文件不同必须有 `transformationRef`，最终交付与接收确认必须对应最终哈希。`credentialsExcluded`、`restricted`、数量及范围都是登记声明，校验器不会查看文件来证明这些声明；没有记录引用的真实证据时不能把报告写成现实工作完成。

```sh
node scripts/verify-controlled-delivery.mjs --help
node scripts/verify-controlled-delivery.mjs --demo
node scripts/verify-controlled-delivery.mjs --example approve > '/私密工作目录/合成交付登记.json'
node scripts/verify-controlled-delivery.mjs --record '/私密工作目录/合成交付登记.json'
node scripts/verify-controlled-delivery.mjs --example refuse > '/私密工作目录/合成拒绝登记.json'
node scripts/verify-controlled-delivery.mjs --record '/私密工作目录/合成拒绝登记.json'
node --test test/controlled-delivery.test.mjs
```

输出只含固定结果/原因码和字段位置，不回显输入的文书、主体、路径、人员标识或文件内容。`--example` 仅输出内置合成模板，不读取输入资料。`--record` 仅读取显式给出的不超过 1 MiB 的常规 JSON 文件，退出 0 表示完整或拒绝归档记录一致，退出 1 表示记录无效/不可读，退出 2 表示参数错误；缺哈希、缺接收确认、时间逆序、无核验批准、超范围和假称完整均失败。

`--demo` 在内存中生成一段显式合成内容字节、计算真实 SHA-256，依次填写合成登记→四项核验→范围/决定→取数/审计/哈希→模拟交付/同哈希确认→归档，以及主体未确认的拒绝归档。所有单位、经办和角色都是合成引用，不代表现实主体；模拟接收不是送达。报告始终标明 `evidenceBoundary:'record_consistency_only'`、`externalDeliveryVerified:false`、`productionDataRead:false`、`dataSent:false`。

## 6. 组织演练、生产关卡与验收记录

组织可在本地合成环境另做投诉处置演练：给合成投诉编号，登记处理角色、时间、处理与必要交接，核对投诉始终私密、处理与公开分离、未结事项可追踪。2026-10-08负责人已确认开发团队共同管理、收到投诉后处理、需要协作时在内部飞书群沟通，对外资料由团队开发者核对发送；不再要求提供成员名单、逐人拆分角色或新增复杂排班。此为现行做法的用户确认，具体处置/交付凭证和适用保留策略仍按实际事项核实，不能由本轮离线校验代替。

本轮交付流程的验收包括：完整合成记录、主体不明和超范围拒绝、批准/取数跨账号或跨站点、移除时间筛选、缺哈希/接收确认、错误接收对象、伪称完整、部分结果限制确认、变换前后哈希链、事件时间与私密归档，以及纯离线无读生产/无写入/无网络副作用。实际运行结果与证据路径在主窗口 S4 验收记录汇总，不引用未运行的数字。

生产仍需按最终固定候选验证管理员隔离、完整数据/审计、真实下载字节哈希和上限行为；入口日志还需真实时间窗、各站点/代理拓扑、脱敏字段、全窗覆盖/空档及私密权限的回执。现实请求的材料真实性、依据、接收对象、受控渠道、接收确认、归档与保留策略只能由实际负责人和操作人确认。本次不读取生产、不发真实资料/消息，不以本地通过关闭这些事项。

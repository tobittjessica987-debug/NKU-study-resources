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

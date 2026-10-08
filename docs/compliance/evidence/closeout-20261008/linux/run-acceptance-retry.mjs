import { spawnSync } from 'node:child_process';
import { openSync, closeSync, writeFileSync } from 'node:fs';
const steps = [
  ['02-npm-test', ['test'], {}],
  ['03-astro-check', ['run','check'], {NODE_OPTIONS:'--max-old-space-size=8192'}],
  ['04-api-docs', ['run','check:api-docs'], {}],
  ['05-fixtures', ['run','check:fixtures'], {}],
  ['06-fixture-content', ['run','check:content'], {DATA_DIR:'/work/fixture-data'}],
  ['07-fixture-encoding', ['run','audit:encoding'], {DATA_DIR:'/work/fixture-data'}],
  ['08-public-api-smoke', ['run','smoke:public-api'], {}],
  ['09-fixture-build', ['run','build:fixtures'], {}],
];
const results = [];
for (const [id,args,extra] of steps) {
  const start = new Date();
  console.log(`${start.toISOString()} START ${id}: npm ${args.join(' ')}`);
  const log = `/work/logs/${id}-retry.log`;
  const fd = openSync(log, 'w', 0o600);
  const result = spawnSync('npm', args, {cwd:'/work/src', env:{...process.env,...extra}, stdio:['ignore',fd,fd]});
  closeSync(fd);
  const end = new Date();
  const entry = {id,command:['npm',...args],environmentOverrides:extra,startedAt:start.toISOString(),endedAt:end.toISOString(),elapsedSeconds:(end-start)/1000,exitCode:result.status,signal:result.signal,error:result.error?.message??null,log};
  results.push(entry);
  writeFileSync(`/work/logs/${id}-retry.exit`, `${result.status??'null'}\n`, {mode:0o600});
  writeFileSync('/work/acceptance-results-retry.json', JSON.stringify(results,null,2)+'\n', {mode:0o600});
  console.log(`${end.toISOString()} END ${id}: exit=${result.status} signal=${result.signal??'none'}`);
}
process.exitCode=results.every(r=>r.exitCode===0&&!r.signal)?0:1;

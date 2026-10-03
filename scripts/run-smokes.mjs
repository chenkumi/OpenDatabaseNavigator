// Builds once, then runs every desktop smoke test that needs no external service.
// `npm run test:desktop:<name>` rebuilds for each test; this avoids 20+ rebuilds.
//   node scripts/run-smokes.mjs [--all] [--no-build]
// --all also runs tests that need the Docker integration services or Windows.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const all = process.argv.includes('--all');
const scripts = JSON.parse(readFileSync('package.json', 'utf8')).scripts;
const smokes = Object.entries(scripts)
  .map(([name, command]) => [
    name,
    /^npm run build && node (scripts\/\S+\.mjs)$/.exec(command)?.[1],
  ])
  .filter(([name, file]) => name.startsWith('test:desktop') && file)
  .filter(([, file]) => {
    if (all) return true;
    const source = readFileSync(file, 'utf8');
    return !source.includes('integrationPassword') && !source.includes('requires Windows');
  });

if (!process.argv.includes('--no-build')) {
  const build = spawnSync('npm', ['run', 'build'], { stdio: 'inherit', shell: true });
  if (build.status !== 0) process.exit(build.status ?? 1);
}
const failed = [];
for (const [name, file] of smokes) {
  console.log(`\n=== ${name} (${file})`);
  const result = spawnSync(process.execPath, [file], { stdio: 'inherit' });
  if (result.status !== 0) failed.push(name);
}
console.log(
  `\n${smokes.length - failed.length}/${smokes.length} desktop smoke tests passed` +
    (failed.length ? `; failed: ${failed.join(', ')}` : ''),
);
process.exit(failed.length ? 1 : 0);

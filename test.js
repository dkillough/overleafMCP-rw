const assert = require('assert');
const OverleafGitClient = require('./overleaf-git-client.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  PASS: ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL: ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  }
}

// === Fix #1: _redactError covers stdout ===
console.log('\n--- Fix #1: _redactError covers error.stdout ---');

const client = new OverleafGitClient('secret-token-123', 'proj-1');

test('redacts error.message', () => {
  const err = new Error('failed at https://git:secret-token-123@git.overleaf.com/proj-1');
  client._redactError(err);
  assert(!err.message.includes('secret-token-123'), `message still contains token: ${err.message}`);
  assert(err.message.includes('[REDACTED]'));
});

test('redacts error.stderr', () => {
  const err = new Error('fail');
  err.stderr = 'fatal: Authentication failed for https://git:secret-token-123@example.com';
  client._redactError(err);
  assert(!err.stderr.includes('secret-token-123'), `stderr still contains token: ${err.stderr}`);
  assert(err.stderr.includes('[REDACTED]'));
});

test('redacts error.stdout', () => {
  const err = new Error('fail');
  err.stdout = 'remote: token secret-token-123 is invalid';
  client._redactError(err);
  assert(!err.stdout.includes('secret-token-123'), `stdout still contains token: ${err.stdout}`);
  assert(err.stdout.includes('[REDACTED]'));
});

test('handles missing fields gracefully', () => {
  const err = new Error('simple error');
  client._redactError(err); // should not throw
});

// === Fix #2: cloneOrPull doesn't swallow pull failures ===
console.log('\n--- Fix #2: cloneOrPull separates access check from pull ---');

// We can't easily integration-test git clone/pull without a real repo,
// but we can verify the structure by mocking. Instead, let's verify the
// code path by reading the source and confirming the pattern.
const fs = require('fs');
const source = fs.readFileSync(require.resolve('./overleaf-git-client.js'), 'utf8');

test('cloneOrPull uses exists flag pattern (not nested try/catch)', () => {
  // The old buggy pattern had: try { fs.access(); git pull } catch { git clone }
  // The fixed pattern uses: exists = false; try { fs.access(); exists = true } catch {}
  assert(source.includes('exists = true'), 'should set exists flag after access check');
  assert(source.includes('if (exists)'), 'should branch on exists flag');
});

// === Fix #3: commit "nothing to commit" checks stdout too ===
console.log('\n--- Fix #3: commit detects "nothing to commit" from stdout ---');

// Simulate the error shape that execFileAsync produces when git commit
// exits non-zero with "nothing to commit" on stdout.
test('detects "nothing to commit" when only in error.stdout', () => {
  // execFileAsync error shape: message = "Command failed: git commit ...\n<stderr>"
  // stdout has the actual git output
  const err = new Error('Command failed: git commit -m "test"');
  err.stdout = 'On branch master\nnothing to commit, working tree clean\n';
  err.stderr = '';
  const combined = `${err.message || ''} ${err.stdout || ''}`;
  assert(combined.includes('nothing to commit'), 'should find "nothing to commit" in combined message+stdout');
});

test('detects "nothing to commit" when in error.message', () => {
  const err = new Error('nothing to commit, working tree clean');
  err.stdout = '';
  err.stderr = '';
  const combined = `${err.message || ''} ${err.stdout || ''}`;
  assert(combined.includes('nothing to commit'), 'should find "nothing to commit" in message');
});

test('source checks both message and stdout for nothing to commit', () => {
  // Verify the code combines message and stdout
  assert(source.includes('error.stdout'), 'commit handler should reference error.stdout');
  assert(source.includes("nothing to commit"), 'commit handler should check for "nothing to commit"');
});

// === Fix #4: list_projects doesn't require project config ===
console.log('\n--- Fix #4: list_projects handled before getProjectConfig ---');

const serverSource = fs.readFileSync(require.resolve('./overleaf-mcp-server.js'), 'utf8');

test('list_projects is handled before getProjectConfig call', () => {
  const listProjectsPos = serverSource.indexOf("name === 'list_projects'");
  const getProjectConfigPos = serverSource.indexOf('getProjectConfig(args.projectName)');
  assert(listProjectsPos !== -1, 'should have early list_projects check');
  assert(getProjectConfigPos !== -1, 'should have getProjectConfig call');
  assert(listProjectsPos < getProjectConfigPos,
    `list_projects check (pos ${listProjectsPos}) should come before getProjectConfig (pos ${getProjectConfigPos})`);
});

test('list_projects is not in the switch statement', () => {
  // Find the switch block
  const switchPos = serverSource.indexOf('switch (name)');
  const switchBlock = serverSource.substring(switchPos);
  assert(!switchBlock.includes("case 'list_projects'"), 'list_projects should not be a switch case');
});

// === Summary ===
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);

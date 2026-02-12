const assert = require('assert');
const { describe, it, before, after } = require('node:test');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const OverleafGitClient = require('./overleaf-git-client.js');

describe('OverleafGitClient constructor validation', () => {
  it('rejects projectId with path traversal characters', () => {
    assert.throws(
      () => new OverleafGitClient('validtoken', '../../etc'),
      /projectId must be alphanumeric/
    );
  });

  it('rejects projectId with slashes', () => {
    assert.throws(
      () => new OverleafGitClient('validtoken', 'foo/bar'),
      /projectId must be alphanumeric/
    );
  });

  it('rejects projectId with spaces', () => {
    assert.throws(
      () => new OverleafGitClient('validtoken', 'foo bar'),
      /projectId must be alphanumeric/
    );
  });

  it('rejects projectId with shell metacharacters', () => {
    assert.throws(
      () => new OverleafGitClient('validtoken', 'foo;rm -rf /'),
      /projectId must be alphanumeric/
    );
  });

  it('rejects gitToken with shell metacharacters', () => {
    assert.throws(
      () => new OverleafGitClient('tok$(whoami)', 'validproject'),
      /gitToken must be alphanumeric/
    );
  });

  it('rejects empty projectId', () => {
    assert.throws(
      () => new OverleafGitClient('validtoken', ''),
      /projectId must be alphanumeric/
    );
  });

  it('rejects empty gitToken', () => {
    assert.throws(
      () => new OverleafGitClient('', 'validproject'),
      /gitToken must be alphanumeric/
    );
  });

  it('accepts valid alphanumeric projectId and gitToken', () => {
    const client = new OverleafGitClient('abc-123_XYZ', 'proj-456_ABC');
    assert.strictEqual(client.projectId, 'proj-456_ABC');
    assert.strictEqual(client.gitToken, 'abc-123_XYZ');
  });
});

describe('askpass script', () => {
  let client;
  let tempDir;

  before(async () => {
    tempDir = path.join(os.tmpdir(), 'overleaf-mcp-test-' + Date.now());
    client = new OverleafGitClient('testtoken123', 'testproject456', tempDir);
    await fs.mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    await client._cleanupAskPassScript();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('creates askpass script with random path component', async () => {
    const scriptPath = await client._createAskPassScript();
    // Should contain projectId but also a UUID
    assert.ok(scriptPath.includes('testproject456'), 'path should contain projectId');
    assert.ok(scriptPath.length > `askpass-testproject456.sh`.length + tempDir.length,
      'path should be longer than static version (contains UUID)');
  });

  it('creates askpass script with unique paths each time', async () => {
    // Clean up so next call generates a new path
    await client._cleanupAskPassScript();
    const path1 = await client._createAskPassScript();
    await client._cleanupAskPassScript();
    const path2 = await client._createAskPassScript();
    assert.notStrictEqual(path1, path2, 'each invocation should produce a unique path');
    await client._cleanupAskPassScript();
  });

  it('creates askpass script with restricted permissions', async () => {
    await client._cleanupAskPassScript();
    const scriptPath = await client._createAskPassScript();
    const stat = await fs.stat(scriptPath);
    // mode includes file type bits; mask to just permission bits
    const perms = stat.mode & 0o777;
    assert.strictEqual(perms, 0o700, `expected 0700 permissions, got ${perms.toString(8)}`);
    await client._cleanupAskPassScript();
  });

  it('askpass script echoes the token', async () => {
    await client._cleanupAskPassScript();
    const scriptPath = await client._createAskPassScript();
    const content = await fs.readFile(scriptPath, 'utf8');
    assert.ok(content.includes("echo 'testtoken123'"), 'script should echo the token');
    assert.ok(content.startsWith('#!/bin/sh'), 'script should have shebang');
    await client._cleanupAskPassScript();
  });

  it('cleanup removes the script file', async () => {
    await client._cleanupAskPassScript();
    const scriptPath = await client._createAskPassScript();
    // Verify file exists
    await fs.access(scriptPath);
    // Cleanup
    await client._cleanupAskPassScript();
    // Verify file is gone
    await assert.rejects(() => fs.access(scriptPath), /ENOENT/);
  });

  it('cleanup is idempotent', async () => {
    await client._cleanupAskPassScript();
    // Should not throw even when nothing to clean
    await client._cleanupAskPassScript();
  });
});

describe('_redactError', () => {
  it('redacts token from error message', () => {
    const client = new OverleafGitClient('secrettoken', 'proj123');
    const error = new Error('failed to auth with secrettoken on server');
    client._redactError(error);
    assert.ok(!error.message.includes('secrettoken'), 'token should be redacted from message');
    assert.ok(error.message.includes('[REDACTED]'), 'should contain [REDACTED] placeholder');
  });

  it('redacts token from stderr', () => {
    const client = new OverleafGitClient('secrettoken', 'proj123');
    const error = new Error('fail');
    error.stderr = 'fatal: auth failed for https://git:secrettoken@git.overleaf.com/proj123';
    client._redactError(error);
    assert.ok(!error.stderr.includes('secrettoken'));
    assert.ok(error.stderr.includes('[REDACTED]'));
  });

  it('redacts token from stdout', () => {
    const client = new OverleafGitClient('secrettoken', 'proj123');
    const error = new Error('fail');
    error.stdout = 'remote: secrettoken leaked';
    client._redactError(error);
    assert.ok(!error.stdout.includes('secrettoken'));
    assert.ok(error.stdout.includes('[REDACTED]'));
  });

  it('handles error with no stderr/stdout gracefully', () => {
    const client = new OverleafGitClient('secrettoken', 'proj123');
    const error = new Error('something else');
    // Should not throw
    client._redactError(error);
    assert.strictEqual(error.message, 'something else');
  });
});

describe('_gitEnv', () => {
  let client;
  let tempDir;

  before(async () => {
    tempDir = path.join(os.tmpdir(), 'overleaf-mcp-test-env-' + Date.now());
    client = new OverleafGitClient('testtoken', 'testproj', tempDir);
    await fs.mkdir(tempDir, { recursive: true });
  });

  after(async () => {
    await client._cleanupAskPassScript();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('returns env with GIT_TERMINAL_PROMPT disabled', async () => {
    const env = await client._gitEnv();
    assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0');
    await client._cleanupAskPassScript();
  });

  it('returns env with GIT_ASKPASS pointing to existing script', async () => {
    const env = await client._gitEnv();
    assert.ok(env.GIT_ASKPASS, 'GIT_ASKPASS should be set');
    // Verify the file exists
    await fs.access(env.GIT_ASKPASS);
    await client._cleanupAskPassScript();
  });
});

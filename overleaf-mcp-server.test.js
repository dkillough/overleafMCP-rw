const assert = require('assert');
const { describe, it } = require('node:test');

// These are copies of the validation functions from overleaf-mcp-server.js.
// We test them here to verify the validation logic without starting the MCP server.

function validateFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('filePath must be a non-empty string');
  }
  if (filePath.includes('..') || filePath.startsWith('/')) {
    throw new Error('filePath must be relative and cannot contain ".."');
  }
  return filePath.trim();
}

function validateContent(content) {
  if (typeof content !== 'string') {
    throw new Error('content must be a string');
  }
  if (content.length > 1000000) {
    throw new Error('content exceeds maximum size of 1MB');
  }
  return content;
}

function validateCommitMessage(message) {
  if (!message || typeof message !== 'string') {
    throw new Error('commit message must be a non-empty string');
  }
  if (message.length > 500) {
    throw new Error('commit message must be less than 500 characters');
  }
  return message.trim();
}

describe('validateFilePath', () => {
  it('rejects null/undefined/empty', () => {
    assert.throws(() => validateFilePath(null), /non-empty string/);
    assert.throws(() => validateFilePath(undefined), /non-empty string/);
    assert.throws(() => validateFilePath(''), /non-empty string/);
  });

  it('rejects path traversal with ..', () => {
    assert.throws(() => validateFilePath('../secret.txt'), /cannot contain/);
    assert.throws(() => validateFilePath('foo/../../etc/passwd'), /cannot contain/);
    assert.throws(() => validateFilePath('..'), /cannot contain/);
  });

  it('rejects absolute paths', () => {
    assert.throws(() => validateFilePath('/etc/passwd'), /cannot contain|must be relative/);
    assert.throws(() => validateFilePath('/tmp/file.tex'), /cannot contain|must be relative/);
  });

  it('accepts valid relative paths', () => {
    assert.strictEqual(validateFilePath('main.tex'), 'main.tex');
    assert.strictEqual(validateFilePath('chapters/intro.tex'), 'chapters/intro.tex');
  });

  it('trims whitespace', () => {
    assert.strictEqual(validateFilePath('  main.tex  '), 'main.tex');
  });
});

describe('validateContent', () => {
  it('rejects non-string content', () => {
    assert.throws(() => validateContent(123), /must be a string/);
    assert.throws(() => validateContent(null), /must be a string/);
  });

  it('rejects content exceeding 1MB', () => {
    const big = 'x'.repeat(1000001);
    assert.throws(() => validateContent(big), /exceeds maximum size/);
  });

  it('accepts valid content', () => {
    assert.strictEqual(validateContent('hello'), 'hello');
  });

  it('accepts empty string', () => {
    assert.strictEqual(validateContent(''), '');
  });

  it('accepts content at exactly 1MB', () => {
    const exact = 'x'.repeat(1000000);
    assert.strictEqual(validateContent(exact), exact);
  });
});

describe('validateCommitMessage', () => {
  it('rejects null/undefined/empty', () => {
    assert.throws(() => validateCommitMessage(null), /non-empty string/);
    assert.throws(() => validateCommitMessage(''), /non-empty string/);
    assert.throws(() => validateCommitMessage(undefined), /non-empty string/);
  });

  it('rejects messages over 500 characters', () => {
    const long = 'a'.repeat(501);
    assert.throws(() => validateCommitMessage(long), /less than 500/);
  });

  it('accepts valid message', () => {
    assert.strictEqual(validateCommitMessage('Fix typo'), 'Fix typo');
  });

  it('trims whitespace', () => {
    assert.strictEqual(validateCommitMessage('  Fix typo  '), 'Fix typo');
  });

  it('accepts message at exactly 500 characters', () => {
    const exact = 'a'.repeat(500);
    assert.strictEqual(validateCommitMessage(exact), exact);
  });
});

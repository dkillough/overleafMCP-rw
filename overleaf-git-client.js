const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

class OverleafGitClient {
    constructor(gitToken, projectId, tempDir = null) {
        if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) {
            throw new Error('projectId must be alphanumeric (with hyphens/underscores)');
        }
        if (!/^[a-zA-Z0-9_-]+$/.test(gitToken)) {
            throw new Error('gitToken must be alphanumeric (with hyphens/underscores)');
        }
        this.gitToken = gitToken;
        this.projectId = projectId;
        // Use OS temp directory if not specified, with absolute path
        this.tempDir = tempDir || path.join(os.tmpdir(), 'overleaf-mcp');
        this.localPath = path.join(this.tempDir, projectId);
        this._askPassScript = null;
    }

    async _createAskPassScript() {
        if (this._askPassScript) return this._askPassScript;
        const scriptPath = path.join(this.tempDir, `askpass-${this.projectId}-${crypto.randomUUID()}.sh`);
        // The script prints the token on stdout when git asks for a password.
        // Username is always "git" for Overleaf, so we only need to supply the password.
        await fs.writeFile(scriptPath, `#!/bin/sh\necho '${this.gitToken}'\n`, { mode: 0o700 });
        this._askPassScript = scriptPath;
        return scriptPath;
    }

    async _cleanupAskPassScript() {
        if (this._askPassScript) {
            await fs.unlink(this._askPassScript).catch(() => {});
            this._askPassScript = null;
        }
    }

    async _gitEnv() {
        const askPass = await this._createAskPassScript();
        return {
            ...process.env,
            GIT_TERMINAL_PROMPT: '0',
            GIT_ASKPASS: askPass,
            // Overleaf expects username "git", supply via env so the URL stays token-free
            GIT_USERNAME: 'git',
        };
    }

    _redactError(error) {
        if (this.gitToken && error.message) {
            error.message = error.message.replaceAll(this.gitToken, '[REDACTED]');
        }
        if (error.stderr) {
            error.stderr = error.stderr.replaceAll(this.gitToken, '[REDACTED]');
        }
        if (error.stdout) {
            error.stdout = error.stdout.replaceAll(this.gitToken, '[REDACTED]');
        }
        return error;
    }

    async cloneOrPull() {
        // Ensure temp directory exists with proper permissions
        await fs.mkdir(this.tempDir, { recursive: true, mode: 0o755 });
        const env = await this._gitEnv();

        try {
            // Check if repo already exists
            let exists = false;
            try {
                await fs.access(this.localPath);
                exists = true;
            } catch {}

            if (exists) {
                // Pull latest changes
                await execFileAsync('git', ['pull'], {
                    cwd: this.localPath,
                    env
                });
            } else {
                // Clone with username in URL; password supplied via GIT_ASKPASS
                const cloneUrl = `https://git@git.overleaf.com/${this.projectId}`;
                await execFileAsync('git', ['clone', cloneUrl, this.localPath], {
                    env
                });
            }
        } catch (error) {
            throw this._redactError(error);
        } finally {
            await this._cleanupAskPassScript();
        }
    }

    async listFiles(extension = '.tex') {
        await this.cloneOrPull();
        
        const files = [];
        async function walk(dir) {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory() && entry.name !== '.git') {
                    await walk(fullPath);
                } else if (entry.isFile() && (!extension || entry.name.endsWith(extension))) {
                    files.push(fullPath);
                }
            }
        }
        
        await walk(this.localPath);
        return files.map(f => path.relative(this.localPath, f));
    }

    async readFile(filePath) {
        await this.cloneOrPull();
        const fullPath = path.join(this.localPath, filePath);
        return await fs.readFile(fullPath, 'utf8');
    }

    async getSections(filePath) {
        const content = await this.readFile(filePath);
        
        const sections = [];
        const sectionRegex = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\{([^}]+)\}/g;
        
        let match;
        let lastIndex = 0;
        
        while ((match = sectionRegex.exec(content)) !== null) {
            const type = match[1];
            const title = match[2];
            const startIndex = match.index;
            
            if (sections.length > 0) {
                sections[sections.length - 1].content = content.substring(lastIndex + match[0].length, startIndex).trim();
            }
            
            sections.push({
                type,
                title,
                startIndex,
                content: ''
            });
            
            lastIndex = startIndex;
        }
        
        if (sections.length > 0) {
            sections[sections.length - 1].content = content.substring(lastIndex + sections[sections.length - 1].title.length + 3).trim();
        }
        
        return sections;
    }

    async getSection(filePath, sectionTitle) {
        const sections = await this.getSections(filePath);
        return sections.find(s => s.title === sectionTitle);
    }

    async getSectionsByType(filePath, type) {
        const sections = await this.getSections(filePath);
        return sections.filter(s => s.type === type);
    }

    async writeFile(filePath, content) {
        await this.cloneOrPull();
        const fullPath = path.join(this.localPath, filePath);
        const dir = path.dirname(fullPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(fullPath, content, 'utf8');
        return fullPath;
    }

    async deleteFile(filePath) {
        await this.cloneOrPull();
        const fullPath = path.join(this.localPath, filePath);
        await fs.unlink(fullPath);
        return fullPath;
    }

    async commit(message) {
        const env = await this._gitEnv();
        try {
            await execFileAsync('git', ['add', '-A'], {
                cwd: this.localPath,
                env,
                timeout: 30000
            });
            const { stdout } = await execFileAsync('git', ['commit', '-m', message], {
                cwd: this.localPath,
                env,
                timeout: 30000
            });
            return stdout || 'Commit successful';
        } catch (error) {
            const combined = `${error.message || ''} ${error.stdout || ''}`;
            if (combined.includes('nothing to commit')) {
                return 'Nothing to commit, working tree clean';
            }
            if (error.message && error.message.includes('timeout')) {
                throw new Error('Commit operation timed out');
            }
            throw new Error(`Commit failed: ${this._redactError(error).message}`);
        } finally {
            await this._cleanupAskPassScript();
        }
    }

    async push() {
        const env = await this._gitEnv();
        try {
            const { stdout } = await execFileAsync('git', ['push'], {
                cwd: this.localPath,
                env,
                timeout: 60000
            });
            return stdout || 'Push successful';
        } catch (error) {
            this._redactError(error);
            if (error.message.includes('timeout')) {
                throw new Error('Push operation timed out - check network connection');
            }
            if (error.message.includes('403')) {
                throw new Error('Push failed: Authentication error - check git token');
            }
            throw new Error(`Push failed: ${error.message}`);
        } finally {
            await this._cleanupAskPassScript();
        }
    }

    async status() {
        await this.cloneOrPull();
        const { stdout } = await execFileAsync('git', ['status'], {
            cwd: this.localPath,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        });
        return stdout;
    }
}

module.exports = OverleafGitClient;
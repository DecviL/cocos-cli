import { fork, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { ProjectBackendLease, discoverProjectBackend, queryProjectBackend, ProjectBackendError } from '../src/core/project-backend/ownership';
import { ensureProjectBackend, stopProjectBackend } from '../src/core/project-backend/client';

describe('project backend discovery and dynamic control ports', () => {
    let project: string;
    const children: ChildProcess[] = [];
    const leases: ProjectBackendLease[] = [];
    let next = 0;
    beforeEach(async () => { project = await mkdtemp(join(process.env.COCOS_BACKEND_TEST_TMPDIR ?? tmpdir(), 'cocos-backend-owner-')); });
    afterEach(async () => {
        for (const lease of leases.splice(0)) await lease.release();
        await Promise.all(children.splice(0).map(child => child.exitCode !== null || child.signalCode ? Promise.resolve() : new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill(); })));
        await rm(project, { recursive: true, force: true });
    });
    function child() {
        const process = fork(resolve(__dirname, 'helpers/project-backend-owner.cjs'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
        children.push(process); return process;
    }
    function call(child: ChildProcess, message: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = ++next;
            const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Owner test timed out')); }, 10000);
            const receive = (response: any) => {
                if (response.id !== id) return;
                clearTimeout(timer); child.off('message', receive);
                response.error ? reject(Object.assign(new Error(response.error.message), response.error)) : resolve(response.value);
            };
            child.on('message', receive); child.send({ id, ...message });
        });
    }

    it('assigns separate control ports to concurrent backends and publishes only discovery metadata', async () => {
        const contenders = [child(), child(), child(), child()];
        const results = await Promise.all(contenders.map(process => call(process, { type: 'acquire', project })));
        expect(new Set(results.map(result => result.url)).size).toBe(4);
        expect((await readdir(join(project, 'temp/.cocos-cli-backend'))).sort()).toEqual(['owner.json']);
        const discovered = await discoverProjectBackend(project);
        expect(discovered?.state).toBe('initializing');
        const index = results.findIndex(result => result.ownerId === discovered?.ownerId);
        expect(index).toBeGreaterThanOrEqual(0);
        const owner = results[index];
        await call(contenders[index], { type: 'publish', patch: { state: 'ready', mcpUrl: 'http://127.0.0.1/mcp', sceneSession: { protocol: 1, project, url: 'http://127.0.0.1:1', token: 'test' } } });
        const reused = await ensureProjectBackend(project);
        expect(reused.ownerId).toBe(owner.ownerId);
        expect(reused.pid).toBe(owner.pid);
    });

    it('recovers automatically after an owner crash and rejects old shutdown credentials', async () => {
        const process = child();
        const old = await call(process, { type: 'acquire', project });
        await new Promise<void>(resolve => { process.once('exit', () => resolve()); process.kill(); });
        expect(await discoverProjectBackend(project)).toBeNull();
        const lease = await ProjectBackendLease.acquire(project); leases.push(lease);
        expect(lease.descriptor.ownerId).not.toBe(old.ownerId);
        const response = await fetch(`${lease.descriptor.url}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${old.token}` } });
        expect(response.status).toBe(401);
        await expect(stopProjectBackend({ ...old, url: lease.descriptor.url })).rejects.toMatchObject({ code: 'OWNER_CHANGED' });
        expect((await discoverProjectBackend(project))?.ownerId).toBe(lease.descriptor.ownerId);
    });

    it('ignores obsolete port registries instead of reusing their saved ports', async () => {
        const registry = join(project, 'temp/.cocos-cli-backend/rendezvous');
        await mkdir(registry, { recursive: true });
        await writeFile(join(registry, 'port.json'), '{');
        await writeFile(join(project, 'temp/.cocos-cli-backend/rendezvous.json'), '{');
        const lease = await ProjectBackendLease.acquire(project); leases.push(lease);
        expect((await discoverProjectBackend(project))?.ownerId).toBe(lease.descriptor.ownerId);
        expect(await readFile(join(registry, 'port.json'), 'utf8')).toBe('{');
    });

    it('canonicalizes aliases and permits different projects', async () => {
        const first = await ProjectBackendLease.acquire(project); leases.push(first);
        const relative = await ProjectBackendLease.acquire(join(project, '.')); leases.push(relative);
        expect(relative.descriptor.project).toBe(first.descriptor.project);
        expect(relative.descriptor.url).not.toBe(first.descriptor.url);
        const other = join(project, 'other'); await mkdir(other);
        const second = await ProjectBackendLease.acquire(other); leases.push(second);
        expect(second.descriptor.url).not.toBe(first.descriptor.url);
        if (process.platform === 'win32' && !process.env.COCOS_BACKEND_TEST_TMPDIR) {
            const alias = join(project, 'alias');
            await symlink(other, alias, 'junction');
            const aliased = await ProjectBackendLease.acquire(alias); leases.push(aliased);
            expect(aliased.descriptor.project).toBe(second.descriptor.project);
        }
    });

    it('reads live state rather than a stale PID and does not terminate a backend on startup timeout', async () => {
        const lease = await ProjectBackendLease.acquire(project); leases.push(lease);
        const ownerFile = join(project, 'temp/.cocos-cli-backend/owner.json');
        const original = await readFile(ownerFile, 'utf8');
        await writeFile(ownerFile, JSON.stringify({ ...JSON.parse(original), pid: 99999999 }));
        await expect(ensureProjectBackend(project, { startupTimeoutMs: 50 })).rejects.toMatchObject({ code: 'STARTUP_TIMEOUT' });
        expect((await discoverProjectBackend(project))?.pid).toBe(process.pid);
        expect((await queryProjectBackend(lease.descriptor))?.ownerId).toBe(lease.descriptor.ownerId);
    });

    it.each(['foreign identity', 'unresponsive'])('starts different projects when a previous control port serves %s', async (mode) => {
        const lease = await ProjectBackendLease.acquire(project);
        const port = Number(new URL(lease.descriptor.url).port);
        await lease.release();
        let requests = 0;
        const unrelated = createServer((_request, response) => { requests++; if (mode === 'foreign identity') response.end('{}'); });
        await new Promise<void>(resolve => unrelated.listen(port, '127.0.0.1', resolve));
        try {
            expect(await discoverProjectBackend(project)).toBeNull();
            const first = await ProjectBackendLease.acquire(project); leases.push(first);
            const other = join(project, 'other'); await mkdir(other);
            await mkdir(join(other, 'temp/.cocos-cli-backend'), { recursive: true });
            await writeFile(join(other, 'temp/.cocos-cli-backend/owner.json'), JSON.stringify(lease.descriptor));
            const second = await ProjectBackendLease.acquire(other); leases.push(second);
            expect(first.descriptor.url).not.toBe(lease.descriptor.url);
            expect(second.descriptor.url).not.toBe(lease.descriptor.url);
            expect(second.descriptor.url).not.toBe(first.descriptor.url);
            expect((await discoverProjectBackend(project))?.ownerId).toBe(first.descriptor.ownerId);
            expect((await discoverProjectBackend(other))?.ownerId).toBe(second.descriptor.ownerId);
            expect(requests).toBe(1);
        }
        finally { await new Promise<void>(resolve => { unrelated.close(() => resolve()); unrelated.closeAllConnections(); }); }
    });

    it('closes a specific backend without stopping a later instance or deleting its discovery metadata', async () => {
        const lease = await ProjectBackendLease.acquire(project);
        lease.onShutdown(() => lease.release());
        const other = await ProjectBackendLease.acquire(project); leases.push(other);
        other.onShutdown(() => other.release());
        await stopProjectBackend(lease.descriptor);
        expect((await discoverProjectBackend(project))?.ownerId).toBe(other.descriptor.ownerId);
        await stopProjectBackend(other.descriptor);
        expect(await discoverProjectBackend(project)).toBeNull();
        const next = await ProjectBackendLease.acquire(project); leases.push(next);
        expect(next.descriptor.ownerId).not.toBe(lease.descriptor.ownerId);
    });

    it('keeps a failed backend discoverable and keeps credentials out of error serialization', async () => {
        const lease = await ProjectBackendLease.acquire(project); leases.push(lease);
        lease.onShutdown(async () => { throw new Error('writer still running'); });
        await expect(lease.requestShutdown()).rejects.toThrow('writer still running');
        expect((await discoverProjectBackend(project))?.state).toBe('failed');
        const error = new ProjectBackendError('BACKEND_FAILED', 'Cleanup failed', lease.descriptor);
        expect(error.backend?.ownerId).toBe(lease.descriptor.ownerId);
        expect(JSON.stringify(error)).not.toContain(lease.descriptor.token);
    });

    it('replaces corrupt discovery metadata on startup', async () => {
        await mkdir(join(project, 'temp/.cocos-cli-backend'), { recursive: true });
        await writeFile(join(project, 'temp/.cocos-cli-backend/owner.json'), '{');
        expect(await discoverProjectBackend(project)).toBeNull();
        const lease = await ProjectBackendLease.acquire(project); leases.push(lease);
        expect((await discoverProjectBackend(project))?.ownerId).toBe(lease.descriptor.ownerId);
    });
});

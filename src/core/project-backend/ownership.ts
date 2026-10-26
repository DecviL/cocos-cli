import { createServer, type Server } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rename, realpath, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { SceneSessionDescriptor } from '../scene/session/protocol';

export interface ProjectBackendDescriptor {
    protocol: 1;
    project: string;
    projectKey: string;
    ownerId: string;
    pid: number;
    url: string;
    token: string;
    state: 'initializing' | 'ready' | 'stopping' | 'failed';
    sceneSession?: SceneSessionDescriptor;
    mcpUrl?: string;
}
export class ProjectBackendError extends Error {
    constructor(public readonly code: string, message: string, public readonly backend?: ProjectBackendDescriptor) {
        super(message); this.name = 'ProjectBackendError';
        // CLI error logging must not accidentally print the owner's connection tokens.
        Object.defineProperty(this, 'backend', { value: backend, enumerable: false });
    }
}
interface Location { project: string; key: string; directory: string; owner: string }

export async function canonicalProject(project: string): Promise<string> {
    const canonical = await realpath(project);
    if (!(await stat(canonical)).isDirectory()) throw new Error('Project must be a directory');
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
async function locate(project: string): Promise<Location> {
    project = await canonicalProject(project);
    const directory = join(project, 'temp', '.cocos-cli-backend');
    return { project, key: createHash('sha256').update(project).digest('hex'), directory,
        owner: join(directory, 'owner.json') };
}
async function atomicWrite(filename: string, value: unknown): Promise<void> {
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(value), { mode: 0o600 }); await retryFileOperation(() => rename(temporary, filename)); }
    finally { await unlink(temporary).catch(() => undefined); }
}
async function retryFileOperation(operation: () => Promise<void>): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try { await operation(); return; }
        catch (error: any) {
            if (attempt >= 8 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
            await new Promise<void>(resolve => setTimeout(resolve, Math.min(20 * 2 ** attempt, 100)));
        }
    }
}
function isRefused(error: any): boolean { return error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED'; }

/** owner.json is a discovery hint for the last publisher, not a project lock. */
export async function discoverProjectBackend(project: string): Promise<ProjectBackendDescriptor | null> {
    const location = await locate(project);
    let stored: ProjectBackendDescriptor;
    try { stored = JSON.parse(await readFile(location.owner, 'utf8')); }
    catch (error: any) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
    }
    try { return await readLiveBackend(location, stored); }
    catch (error) {
        // A cached address may now belong to an unresponsive unrelated service.
        // Discovery is best effort; it must not pin a new startup to that old port.
        if (error instanceof ProjectBackendError && error.code === 'BACKEND_UNREACHABLE') return null;
        throw error;
    }
}

/** Inspect a specific instance even if another backend has since published owner.json. */
export async function queryProjectBackend(backend: ProjectBackendDescriptor): Promise<ProjectBackendDescriptor | null> {
    return readLiveBackend(await locate(backend.project), backend, true);
}

async function readLiveBackend(location: Location, stored: ProjectBackendDescriptor, exactInstance = false): Promise<ProjectBackendDescriptor | null> {
    if (!stored || stored.protocol !== 1 || stored.projectKey !== location.key || stored.project !== location.project
        || typeof stored.ownerId !== 'string' || typeof stored.token !== 'string' || typeof stored.url !== 'string') return null;
    // Never follow a stale or modified descriptor to a remote address or arbitrary path.
    let address: URL;
    try { address = new URL(stored.url); } catch { return null; }
    if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port
        || stored.url !== `http://127.0.0.1:${address.port}`) return null;
    const url = stored.url;
    let identity: any;
    try {
        const response = await fetch(`${url}/identity`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
        if (!response.ok) return null;
        identity = await response.json();
    } catch (error) {
        if (isRefused(error) || error instanceof SyntaxError) return null;
        throw new ProjectBackendError('BACKEND_UNREACHABLE', `Backend listener is unresponsive for ${location.project}`);
    }
    if (identity?.protocol !== 1 || identity.projectKey !== location.key || identity.ownerId !== stored.ownerId) {
        if (exactInstance) throw new ProjectBackendError('OWNER_CHANGED', 'The control endpoint no longer belongs to this backend');
        return null;
    }
    let response: Response;
    try {
        response = await fetch(`${url}/status`, { headers: { authorization: `Bearer ${stored.token}` }, signal: AbortSignal.timeout(2000), redirect: 'error' });
    } catch {
        throw new ProjectBackendError('BACKEND_UNREACHABLE', 'Backend status is temporarily unavailable; ownership must not be replaced');
    }
    if (!response.ok) throw new ProjectBackendError('BACKEND_INITIALIZING', 'Backend credentials changed; retry discovery');
    const live = await response.json() as ProjectBackendDescriptor;
    if (live.protocol !== 1 || live.ownerId !== stored.ownerId || live.projectKey !== location.key
        || live.project !== location.project || live.url !== url || live.token !== stored.token) {
        throw new ProjectBackendError('IDENTITY_MISMATCH', 'Backend identity does not match the project');
    }
    return live;
}

/** Per-process control endpoint and credentials; this does not enforce project exclusivity. */
export class ProjectBackendLease {
    private server: Server;
    private sockets = new Set<import('node:net').Socket>();
    private shutdown?: () => Promise<void>;
    private closing = false;
    private shutdownPromise?: Promise<void>;
    private released = false;
    readonly descriptor: ProjectBackendDescriptor;
    private constructor(private readonly location: Location) {
        this.descriptor = { protocol: 1, project: location.project, projectKey: location.key, ownerId: randomUUID(),
            pid: process.pid, url: '', token: randomBytes(32).toString('hex'), state: 'initializing' };
        const auth = Buffer.from(`Bearer ${this.descriptor.token}`);
        this.server = createServer((request, response) => {
            response.setHeader('content-type', 'application/json');
            response.setHeader('cache-control', 'no-store');
            if (request.method === 'GET' && request.url === '/identity') {
                response.end(JSON.stringify({ protocol: 1, projectKey: location.key, ownerId: this.descriptor.ownerId })); return;
            }
            const supplied = Buffer.from(request.headers.authorization ?? '');
            if (supplied.length !== auth.length || !timingSafeEqual(supplied, auth)) { response.writeHead(401); response.end('{}'); return; }
            if (request.method === 'GET' && request.url === '/status') { response.end(JSON.stringify(this.descriptor)); return; }
            if (request.method === 'POST' && request.url === '/shutdown' && this.shutdown && !this.closing) {
                this.closing = true;
                this.descriptor.state = 'stopping';
                response.writeHead(202); response.end('{}');
                void this.requestShutdown().catch(error => { console.error('[Backend] Shutdown failed; ownership retained:', error); });
                return;
            }
            response.writeHead(409); response.end('{}');
        });
        this.server.on('connection', socket => { this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); });
        this.server.requestTimeout = 5000;
        this.server.headersTimeout = 5000;
    }
    static async acquire(project: string): Promise<ProjectBackendLease> {
        const location = await locate(project);
        await mkdir(location.directory, { recursive: true, mode: 0o700 });
        const lease = new ProjectBackendLease(location);
        try {
            await lease.listen();
            const port = (lease.server.address() as import('node:net').AddressInfo).port;
            lease.descriptor.url = `http://127.0.0.1:${port}`;
            await atomicWrite(location.owner, lease.descriptor);
            // Do not keep an otherwise finished one-shot CLI invocation alive solely for its ownership endpoint.
            lease.server.unref();
            return lease;
        } catch (error) {
            await lease.closeListener();
            throw error;
        }
    }
    private listen(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, () => { this.server.off('error', reject); resolve(); });
        });
    }
    onShutdown(shutdown: () => Promise<void>): void { this.shutdown = shutdown; }
    requestShutdown(): Promise<void> {
        return this.shutdownPromise ??= (async () => {
            if (!this.shutdown) throw new Error('No backend shutdown handler is installed');
            this.closing = true;
            this.descriptor.state = 'stopping';
            try { await this.shutdown(); }
            catch (error) { this.descriptor.state = 'failed'; this.server.ref(); throw error; }
        })();
    }
    async publish(patch: Partial<Pick<ProjectBackendDescriptor, 'state' | 'sceneSession' | 'mcpUrl'>>): Promise<void> {
        if (this.released) throw new Error('Backend ownership has been released');
        Object.assign(this.descriptor, patch);
        if (patch.state === 'failed') this.server.ref();
        // The file contains boot credentials only. State/endpoints are read from authenticated /status.
        // Replacing a credentials file for every state transition races Windows file readers unnecessarily.
    }
    /** Close this instance only after its project resources have stopped. */
    async release(): Promise<void> {
        if (this.released) return;
        this.released = true;
        try { await this.closeListener(); }
        catch (error) { this.released = false; throw error; }
        // Leave the discovery hint in place: deleting it could race another publisher.
        // Discovery checks the live identity; the next startup replaces stale metadata.
    }
    private async closeListener(): Promise<void> {
        const closed = new Promise<void>((resolve, reject) => this.server.close(error => error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(error) : resolve()));
        for (const socket of this.sockets) socket.destroy();
        await closed;
    }
}

let ownership: Promise<ProjectBackendLease> | undefined;
/** Process-wide project ownership for the CLI's singleton engine/asset/script modules. */
export async function ensureProjectOwnership(project: string): Promise<ProjectBackendLease> {
    const canonical = await canonicalProject(project);
    if (!ownership) {
        const pending = ProjectBackendLease.acquire(canonical).then(lease => {
            // Low-level SDK initialization has the same lifetime guarantee as Launcher startup.
            lease.onShutdown(async () => {
                const { shutdownProjectResources } = await import('./runtime');
                await shutdownProjectResources(lease);
            });
            return lease;
        });
        ownership = pending;
        void pending.catch(() => { if (ownership === pending) ownership = undefined; });
    }
    const lease = await ownership;
    if (lease.descriptor.project !== canonical) throw new ProjectBackendError('PROCESS_PROJECT_CONFLICT', 'One CLI process can initialize only one project; use a separate backend process');
    return lease;
}
export async function releaseProjectOwnership(lease: ProjectBackendLease): Promise<void> {
    await lease.release();
    if (ownership && await ownership === lease) ownership = undefined;
}
export async function currentProjectOwnership(): Promise<ProjectBackendLease | undefined> { return ownership; }

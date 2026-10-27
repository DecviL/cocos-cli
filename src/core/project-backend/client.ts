import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { canonicalProject, discoverProjectBackend, queryProjectBackend, ProjectBackendError, type ProjectBackendDescriptor } from './ownership';

export interface StartProjectBackendOptions {
    port?: number;
    allowedOrigins?: string[];
    /** Node executable; IDEs hosted in Electron may supply a bundled Node executable. */
    executable?: string;
    startupTimeoutMs?: number;
    /** Defaults to true. Existing owners without MCP are not silently replaced. */
    requireMcp?: boolean;
}
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 100));
const pendingStarts = new Map<string, Promise<ProjectBackendDescriptor>>();

async function waitReady(project: string, options: StartProjectBackendOptions): Promise<ProjectBackendDescriptor> {
    const deadline = Date.now() + (options.startupTimeoutMs ?? 180000);
    let observed: ProjectBackendDescriptor | null = null;
    while (Date.now() < deadline) {
        try { observed = await discoverProjectBackend(project); }
        catch (error) {
            if (!(error instanceof ProjectBackendError) || !['BACKEND_INITIALIZING', 'BACKEND_UNREACHABLE'].includes(error.code)) throw error;
            await pause();
            continue;
        }
        if (!observed) throw new ProjectBackendError('OWNER_EXITED', 'The previous backend exited before it became ready');
        if (observed?.state === 'ready' && observed.sceneSession) {
            if (options.requireMcp !== false && !observed.mcpUrl) {
                throw new ProjectBackendError('CAPABILITY_MISSING', 'The existing owner has no MCP endpoint; register MCP in that owner instead of starting another backend', observed);
            }
            return observed;
        }
        if (observed?.state === 'failed') throw new ProjectBackendError('BACKEND_FAILED', 'Existing backend failed; ownership remains held until it exits', observed);
        await pause();
    }
    throw new ProjectBackendError('STARTUP_TIMEOUT', 'Backend did not become ready; an initializing backend is not terminated automatically', observed ?? undefined);
}

/** Start a separate backend with a dynamically assigned control endpoint. */
export async function startProjectBackend(project: string, options: StartProjectBackendOptions = {}): Promise<ProjectBackendDescriptor> {
    project = await canonicalProject(project);
    // Launch the built entry even when the SDK caller itself is running TypeScript sources.
    const entry = join(__dirname, '../../../dist/core/project-backend/entry.js');
    const child = spawn(options.executable ?? process.execPath, [entry, project, JSON.stringify({ port: options.port, allowedOrigins: options.allowedOrigins })], {
        detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.unref();
    // Readiness comes from this child, not owner.json, which another instance may replace.
    return new Promise<ProjectBackendDescriptor>((resolve, reject) => {
        const finish = (error?: Error, backend?: ProjectBackendDescriptor) => {
            clearTimeout(timer);
            child.off('error', onError);
            child.off('exit', onExit);
            child.off('message', onMessage);
            if (child.connected) child.disconnect();
            if (error) reject(error); else resolve(backend!);
        };
        const onError = (error: Error) => finish(error);
        const onExit = (code: number | null) => finish(new ProjectBackendError('STARTUP_FAILED', `Backend process exited before ready (code ${code}); inspect temp/logs/cocos.log`));
        const onMessage = (message: any) => {
            if (message?.type !== 'project-backend-ready') return;
            const backend = message.backend as ProjectBackendDescriptor;
            if (!backend || backend.protocol !== 1 || backend.pid !== child.pid || backend.project !== project
                || backend.state !== 'ready' || !backend.sceneSession) {
                finish(new ProjectBackendError('IDENTITY_MISMATCH', 'Invalid backend startup response'));
            } else if (options.requireMcp !== false && !backend.mcpUrl) {
                finish(new ProjectBackendError('CAPABILITY_MISSING', 'The started backend has no MCP endpoint'));
            } else finish(undefined, backend);
        };
        const timer = setTimeout(() => finish(new ProjectBackendError('STARTUP_TIMEOUT', 'Backend did not become ready within the startup deadline')), options.startupTimeoutMs ?? 180000);
        child.on('error', onError);
        child.on('exit', onExit);
        child.on('message', onMessage);
    });
}

/** Discover/reuse a backend, sharing startup requests within this calling process. */
export async function ensureProjectBackend(project: string, options: StartProjectBackendOptions = {}): Promise<ProjectBackendDescriptor> {
    project = await canonicalProject(project);
    const pending = pendingStarts.get(project);
    if (pending) return pending;
    const startup = ensureBackend(project, options);
    pendingStarts.set(project, startup);
    try { return await startup; }
    finally { if (pendingStarts.get(project) === startup) pendingStarts.delete(project); }
}

async function ensureBackend(project: string, options: StartProjectBackendOptions): Promise<ProjectBackendDescriptor> {
    const deadline = Date.now() + (options.startupTimeoutMs ?? 180000);
    while (Date.now() < deadline) {
        try {
            const remaining = { ...options, startupTimeoutMs: Math.max(1, deadline - Date.now()) };
            const existing = await discoverProjectBackend(project);
            if (existing) return await waitReady(project, remaining);
            return await startProjectBackend(project, remaining);
        } catch (error) {
            if (!(error instanceof ProjectBackendError) || !['BACKEND_INITIALIZING', 'BACKEND_UNREACHABLE', 'OWNER_EXITED'].includes(error.code)) throw error;
            await pause();
        }
    }
    throw new ProjectBackendError('STARTUP_TIMEOUT', 'No ready backend was available within the startup deadline');
}

/** Explicit owner shutdown, not an editor/view disconnect operation. */
export async function stopProjectBackend(backend: ProjectBackendDescriptor): Promise<void> {
    const current = await queryProjectBackend(backend);
    if (!current) return;
    if (current.ownerId !== backend.ownerId || current.token !== backend.token) throw new ProjectBackendError('OWNER_CHANGED', 'Refusing to stop a replacement backend');
    if (current.state === 'failed') throw new ProjectBackendError('SHUTDOWN_FAILED', 'Backend cleanup previously failed; ownership is retained', current);
    if (current.state !== 'stopping') {
        const response = await fetch(`${current.url}/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${backend.token}` }, signal: AbortSignal.timeout(5000), redirect: 'error' });
        if (response.status !== 202) throw new ProjectBackendError('SHUTDOWN_REFUSED', 'The owner cannot accept shutdown', current);
    }
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        let observed: ProjectBackendDescriptor | null;
        try { observed = await queryProjectBackend(backend); }
        catch (error) {
            if (error instanceof ProjectBackendError && ['BACKEND_INITIALIZING', 'BACKEND_UNREACHABLE'].includes(error.code)) { await pause(); continue; }
            throw error;
        }
        if (!observed || observed.ownerId !== backend.ownerId) return;
        if (observed.state === 'failed') throw new ProjectBackendError('SHUTDOWN_FAILED', 'Project cleanup failed; ownership was retained', observed);
        await pause();
    }
    throw new ProjectBackendError('SHUTDOWN_TIMEOUT', 'The backend is still stopping; ownership has not been stolen');
}

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

jest.mock('node:child_process', () => ({ ...jest.requireActual('node:child_process'), spawn: jest.fn() }));

import { ensureProjectBackend, startProjectBackend, stopProjectBackend } from '../src/core/project-backend/client';
import { discoverProjectBackend, queryProjectBackend, type ProjectBackendDescriptor } from '../src/core/project-backend/ownership';

const realSpawn = jest.requireActual<typeof import('node:child_process')>('node:child_process').spawn;
const mockSpawn = spawn as jest.Mock;

describe('managed backend discovery with dynamic control ports', () => {
    let project: string;
    const children: ChildProcess[] = [];
    const backends: ProjectBackendDescriptor[] = [];

    beforeEach(async () => {
        project = await mkdtemp(join(tmpdir(), 'cocos-backend-client-'));
        mockSpawn.mockReset().mockImplementation((executable, args, options) => {
            const child = realSpawn(executable, [resolve(__dirname, 'helpers/project-backend-managed.cjs'), ...args.slice(1)], options);
            children.push(child);
            return child;
        });
    });
    afterEach(async () => {
        for (const backend of backends.splice(0)) await stopProjectBackend(backend);
        await Promise.all(children.splice(0).map(child => child.exitCode !== null || child.signalCode ? Promise.resolve() : new Promise<void>(resolve => {
            child.once('exit', () => resolve());
            child.kill();
        })));
        await rm(project, { recursive: true, force: true });
    });

    it('returns each spawned instance through IPC even when their owner.json writes overlap', async () => {
        const results = await Promise.all([startProjectBackend(project), startProjectBackend(project)]);
        backends.push(...results);
        expect(new Set(results.map(backend => backend.pid)).size).toBe(2);
        expect(new Set(results.map(backend => backend.url)).size).toBe(2);
        for (const backend of results) {
            expect((await queryProjectBackend(backend))?.ownerId).toBe(backend.ownerId);
        }
        expect(results.map(backend => backend.ownerId)).toContain((await discoverProjectBackend(project))?.ownerId);
        await stopProjectBackend(results[0]);
        expect((await queryProjectBackend(results[1]))?.ownerId).toBe(results[1].ownerId);
    });

    it('shares concurrent ensure calls in one caller and reuses an existing ready backend', async () => {
        const results = await Promise.all([ensureProjectBackend(project), ensureProjectBackend(project)]);
        backends.push(results[0]);
        expect(results[0].ownerId).toBe(results[1].ownerId);
        expect(mockSpawn).toHaveBeenCalledTimes(1);
        expect((await ensureProjectBackend(project)).ownerId).toBe(results[0].ownerId);
        expect(mockSpawn).toHaveBeenCalledTimes(1);
    });

    it('reports a child that exits before publishing readiness', async () => {
        mockSpawn.mockImplementationOnce((executable, _args, options) => {
            const child = realSpawn(executable, ['-e', 'process.exit(23)'], options);
            children.push(child);
            return child;
        });
        await expect(startProjectBackend(project)).rejects.toMatchObject({ code: 'STARTUP_FAILED' });
        expect(await discoverProjectBackend(project)).toBeNull();
    });

});

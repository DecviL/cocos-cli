// Lightweight managed backend for exercising real parent/child IPC without an engine.
const { ProjectBackendLease } = require('../../dist/core/project-backend/ownership');

async function main() {
    const lease = await ProjectBackendLease.acquire(process.argv[2]);
    const keepAlive = setInterval(() => undefined, 1000);
    const close = async () => {
        await lease.release();
        clearInterval(keepAlive);
        process.exit(0);
    };
    lease.onShutdown(close);
    process.once('SIGTERM', () => { void close(); });
    await lease.publish({
        state: 'ready',
        mcpUrl: `${lease.descriptor.url}/mcp`,
        sceneSession: { protocol: 1, project: lease.descriptor.project, url: lease.descriptor.url, token: lease.descriptor.token },
    });
    process.send({ type: 'project-backend-ready', backend: lease.descriptor });
}

void main().catch(error => { console.error(error); process.exit(1); });

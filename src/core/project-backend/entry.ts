// Spawned by Project.ensureProjectBackend. No editor/private-package dependency.
import { startServer } from '../../mcp/start-server';
import { currentProjectOwnership } from './ownership';

async function main() {
    const project = process.argv[2];
    if (!project) throw new Error('Project path is required');
    const options = JSON.parse(process.argv[3] ?? '{}');
    const backend = await startServer(project, options.port, { sceneSessionOrigins: options.allowedOrigins });
    let closing = false;
    const close = async () => {
        if (closing) return;
        closing = true;
        try { await backend.close(); process.exit(0); }
        catch (error) { console.error(error); throw error; }
    };
    process.once('SIGINT', () => { void close().catch(() => undefined); });
    process.once('SIGTERM', () => { void close().catch(() => undefined); });
    (await currentProjectOwnership())?.onShutdown(close);
    // A project may have multiple backends; report this instance directly to its caller.
    if (process.send) {
        process.send({ type: 'project-backend-ready', backend: (await currentProjectOwnership())?.descriptor }, () => undefined);
    }
}
void main().catch(async error => {
    console.error(error);
    // Failed cleanup may leave writers alive. Keep this instance discoverable for diagnosis.
    if ((await currentProjectOwnership())?.descriptor.state === 'failed') return;
    process.exit(1);
});

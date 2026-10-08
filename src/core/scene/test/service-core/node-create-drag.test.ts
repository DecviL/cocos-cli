import type { Node } from 'cc';
import type { ICreateDragHost } from '../../scene-process/service/node/node-create-drag';

class MockCanvas {}

/** 模拟引擎延迟销毁：destroy 后仍在父级 children 中，帧末才递归移除 */
class MockNode {
    children: MockNode[] = [];
    components: MockCanvas[] = [];
    parent: MockNode | null = null;
    objFlags = 0;
    layer = 0;
    isValid = true;
    pendingDestroy = false;

    constructor(public name = 'Node') {}

    setParent(parent: MockNode | null): void {
        if (this.parent) {
            this.parent.children = this.parent.children.filter(child => child !== this);
        }
        this.parent = parent;
        parent?.children.push(this);
    }

    walk(visitor: (node: MockNode) => void): void {
        visitor(this);
        this.children.forEach(child => child.walk(visitor));
    }

    setWorldPosition(): void {}

    destroy(): void {
        this.pendingDestroy = true;
    }

    flushDestroy(): void {
        for (const child of [...this.children]) {
            child.flushDestroy();
        }
        this.setParent(null);
        this.isValid = false;
    }
}

let mockScene: MockNode;
let mockSlider: MockNode;
let mockPreviewCanvas: MockNode;
const mockEvents = { on: jest.fn(), off: jest.fn(), emit: jest.fn() };

jest.mock('cc', () => ({
    Node: MockNode,
    Canvas: MockCanvas,
    CCObject: { Flags: { DontSave: 1, HideInHierarchy: 2, LockedInEditor: 4 } },
    director: { getScene: () => mockScene },
    instantiate: () => mockPreviewCanvas,
}));

jest.mock('../../scene-process/service/core', () => ({
    ServiceEvents: mockEvents,
    Service: {
        Editor: {
            getRootNode: () => mockScene,
            getCurrentEditorType: () => 'scene',
            getEditorSession: () => ({ generation: 1 }),
            isCurrentEditorSession: () => true,
            lock: async () => undefined,
            unlock: () => undefined,
        },
        Camera: { is2D: true },
        PreviewPlay: { getState: () => 'stop' },
        Prefab: { removePrefabInfoFromNode: () => undefined },
        Undo: { beginGroup: () => 'group', endGroup: () => undefined },
    },
}));
jest.mock('../../scene-process/rpc', () => ({ Rpc: {} }));
jest.mock('../../scene-process/service/node/node-create', () => ({
    createNodeByAsset: async () => ({ node: mockSlider, canvasRequired: true }),
    loadAny: async () => ({}),
}));
jest.mock('../../scene-process/service/node/index', () => ({ __esModule: true, default: {} }));
jest.mock('../../scene-process/service/node/drag-placement', () => ({
    computeWorldDropPoint: () => null,
    pointerMatchesCanvas: () => true,
    validatePointer: () => true,
}));

Object.assign(globalThis, {
    EditorExtends: { Node: { getNodePath: (node: MockNode) => `/${node.parent?.name}/${node.name}` } },
});

const { NodeCreateDragManager } = require('../../scene-process/service/node/node-create-drag') as
    typeof import('../../scene-process/service/node/node-create-drag');
const { getUICanvasNode } = require('../../scene-process/service/node/node-utils') as
    typeof import('../../scene-process/service/node/node-utils');

const pointer = {
    x: 100, y: 100, width: 800, height: 600, sequence: 1,
    viewport: { x: 0, y: 0, width: 1, height: 1 },
};

/** 保留真实 Canvas 查找逻辑，隔离资源加载、坐标计算和 Undo 存储 */
function createManager(): InstanceType<typeof NodeCreateDragManager> {
    const host: ICreateDragHost = {
        resolveCanvasTransaction: async () => {
            let parent = getUICanvasNode(mockScene as unknown as Node);
            if (!parent) {
                const canvas = new MockNode('Canvas');
                canvas.components.push(new MockCanvas());
                canvas.setParent(mockScene);
                parent = canvas as unknown as Node;
            }
            return { parent, mutation: null };
        },
        collectSceneNodeUuidsForUndo: () => new Set(),
        beginPrefabCanvasUndoCapture: () => [],
        endPrefabCanvasUndoCapture: () => undefined,
        recordCreateNodeCommand: () => undefined,
    };
    return new NodeCreateDragManager(host);
}

describe('NodeCreateDragManager preview Canvas cleanup', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockScene = new MockNode('Scene');
        mockSlider = new MockNode('Slider');
        mockPreviewCanvas = new MockNode('PreviewCanvas');
        mockPreviewCanvas.components.push(new MockCanvas());
    });

    it.each([true, false])('keeps a committed Slider after deferred destruction (existing Canvas: %s)', async existing => {
        if (existing) {
            const canvas = new MockNode('Canvas');
            canvas.components.push(new MockCanvas());
            canvas.setParent(mockScene);
        }
        const manager = createManager();
        try {
            const sessionId = 'slider-drag';
            expect(await manager.begin({
                sessionId, pointer, items: [{ dbURL: 'db://internal/node-library/slider' }],
            })).toEqual({ ok: true, value: { sessionId, state: 'previewing' } });

            const result = await manager.commit({ sessionId, pointer });
            expect(mockPreviewCanvas.pendingDestroy).toBe(true);
            mockPreviewCanvas.flushDestroy();

            expect({
                state: result.ok ? result.value.state : result.error.code,
                sliderValid: mockSlider.isValid,
                parent: mockSlider.parent?.name,
                flags: mockSlider.objFlags,
            }).toEqual({ state: 'committed', sliderValid: true, parent: 'Canvas', flags: 0 });
        } finally {
            manager.dispose();
        }
    });
});

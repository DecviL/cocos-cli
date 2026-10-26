# CLI 项目后端发现与生命周期

> 本文描述独立 CLI / Worker 后端的发现与兼容共享会话。PinK 已选择 Webview 持有唯一编辑场景，MCP 经已有 Provider/Broker 路由到该场景；不得为该会话再调用 ensure 启动第二份 Worker。私有模块接入见其 `docs/zh/host-runtime.md`。

## 责任和边界

CLI 为每个后端进程动态分配本机控制端口，**不保证同一项目只有一个后端进程**。IDE 调用发现/启动接口，scene-editor 连接返回的场景会话。不同项目不会复用持久化的控制端口；同一个 CLI 进程内的资源、脚本和引擎模块仍是单项目实例。

`Launcher.import/startup/build` 在初始化日志、配置、引擎、脚本和资源库前建立当前进程的控制端点。低层 SDK 的 `Configuration.init`、`Project.init`、`Scripting.init`、`Assets.init` 和 `Scene.startupWorker` 也复用当前进程的控制端点，不会创建项目级文件锁。

MCP 和共享场景接口在 CLI 后端进程中提供，场景引擎由该后端的 Worker 执行；scene-editor/IDE 进程不另开项目资源库和 Worker。

## IDE 推荐入口

下面的模块可以在 IDE 管理进程中导入；调用 `ensureProjectBackend` 不会在 IDE 进程内初始化项目，而是发现或启动独立 CLI 后端。

```ts
import {
  ensureProjectBackend,
  discoverProjectBackend,
  stopProjectBackend,
} from 'cocos-cli/host/lib/project/project';
import { connectSceneEditor } from '@cocos/scene-editor/session';

const backend = await ensureProjectBackend(projectPath, {
  startupTimeoutMs: 180_000,
  // 仅新建后端时使用；已有后端的配置不会被连接者隐式改变。
  allowedOrigins: [editorWebViewOrigin],
});

// IDE 把 backend.mcpUrl 提供给 MCP 客户端。
const editor = await connectSceneEditor({
  descriptor: backend.sceneSession!,
  source: 'ide-window-1',
  onSnapshot: updateEditorView,
  onError: reportConnectionError,
});

// 关闭一个窗口只断开它的客户端：
await editor.close();

// 只有明确关闭整个项目后端时才执行，会影响所有连接者：
await stopProjectBackend(backend);
```

浏览器 WebView 也可直接把 `backend.sceneSession` 交给场景 bundle 的 `startup.sharedSession`。引擎、脚本和静态资源仍使用 IDE 的资源宿主 URL，见独立 `pink-scene-editor-extension` 仓库中的 `docs/zh/shared-session.md`（共享场景接入）。多个 WebView 应使用事先允许的稳定 origin，或由 IDE Node 进程连接并通过自身 IPC 转发；`ensure` 复用后端时不会自动扩大 origin 白名单。

### 导出接口

| 接口 | 行为 |
| --- | --- |
| `discoverProjectBackend(project)` | 读取最后发布的连接信息并校验活后端身份；返回实时描述符或 `null` |
| `startProjectBackend(project, options?)` | 启动新的独立后端，通过父子进程 IPC 返回该实例的就绪描述符 |
| `ensureProjectBackend(project, options?)` | 有可发现后端则等待就绪并复用；没有才启动；同一调用进程内合并并发启动请求 |
| `stopProjectBackend(descriptor)` | 通过指定实例的控制地址、ownerId/token 请求正常关闭并等待，不依赖最后发布的 owner.json |
| `Project.close()` | 关闭当前进程持有的项目后端；适用于自行使用低层 SDK 初始化项目的宿主 |

`StartProjectBackendOptions`：`port` 为新后端 MCP HTTP 服务首选端口；`allowedOrigins` 为新后端场景服务白名单；`executable` 可指定 Node 路径；`startupTimeoutMs` 默认 180 秒；`requireMcp` 默认 true。连接一个不提供 MCP 的 SDK 后端时显式设 `requireMcp: false`。

`ProjectBackendDescriptor` 包含 `project/projectKey/ownerId/pid/url/token/state/sceneSession/mcpUrl`。`url` 是所有权控制端点，`sceneSession.url` 是场景命令端点，`mcpUrl` 是 MCP 地址，三者用途不同。描述符包含访问凭据，不应打印到公共日志或写入版本库。

`state` 为 `initializing/ready/stopping/failed`。初始化超时只表示调用方停止等待，不会杀死正在初始化的所有者；后续可以重新发现。已有后端缺少 MCP 时返回 `CAPABILITY_MISSING`，不会为了补能力再启动第二个项目。

发现是尽力而为的连接提示：已经失效、身份不符或超时的旧地址不会作为当前项目的活后端，不阻止重新启动。通过已持有描述符查询或关闭指定实例时，控制端点超时仍返回 `BACKEND_UNREACHABLE`。跨进程启动不再保证单实例。

## 命令行和生命周期

原来的 `cocos start-mcp-server --project ...` 也会建立控制端点并提供共享场景服务。重复命令可以启动另一个实例，IDE 要复用时使用 `ensureProjectBackend`。`--scene-session-file` 仍可额外导出场景连接描述符。MCP HTTP 服务的端口选择仍由服务器处理，与动态控制端口独立。

普通构建/导入也会建立当前进程的控制端点；独立进程之间不再互斥。多个后端并发修改同一项目时，需要由调用方协调，或通过已有后端的 MCP 接口执行。

`Launcher.close()` 按顺序关闭场景服务、Worker、HTTP 服务、资源库、脚本服务并保存项目元数据，最后关闭本实例的控制端点。初始化中途失败会清理已经启动的部分。清理失败时保留控制端点并将状态设为 `failed`，供调用方诊断处理。

## 控制端点与发现

1. `realpath` 解析项目路径，Windows 统一大小写，让相对路径、目录别名和 junction 使用同一个项目身份。
2. 每次启动通过 `listen(0, '127.0.0.1')` 让操作系统分配当前空闲的控制端口。不创建、读取或迁移 `rendezvous/port.json`、`rendezvous.json`。
3. 控制端点监听成功后，将本次控制地址、随机 ownerId、PID 和 token 原子写入 `temp/.cocos-cli-backend/owner.json`。不同后端独立监听；该文件只指向最后一次发布的实例，不承担互斥职责。
4. 发现接口从 `owner.json` 取得连接信息，再校验控制端点的项目身份和 ownerId，通过认证后的 `/status` 获取实时状态和服务地址，不依赖文件中的旧 PID 或状态。启动 SDK 通过父子进程 IPC 接收新实例的描述符，避免并发发布时误认其他实例。
5. 关闭或崩溃后，操作系统释放该实例的端口。保留的 `owner.json` 仅为可能失效的发现提示，后续启动会覆盖；关闭时不删除文件，避免误删其他实例刚发布的连接信息。旧凭据不能授权关闭另一个实例。

无需硬链接或新增原生依赖，可用于 NTFS 和 exFAT。新启动不依赖之前的控制端口，旧端口被其他项目或程序占用不会阻止分配新的空闲控制端口。升级前需要关闭旧后端并统一升级启动入口；旧版仍依赖固定端口注册，不能与新版协调启动。

这里提供后端发现和生命周期管理，不提供项目单实例保护或跨机器共享盘锁。后端崩溃后的未保存场景恢复仍需单独的恢复日志。

## 验证

单元/进程测试覆盖并发动态端口分配、路径别名、不同项目、异常退出恢复、旧凭据失效、旧端口被占用后启动、实例独立关闭和初始化失败清理。

真实 CLI 后端测试（需要已构建的 `dist` 和本机引擎依赖）：

```powershell
$env:COCOS_TEST_PROJECT_BACKEND = '1'
node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/project-backend-runtime.test.ts
```

测试只使用空闲的集成测试项目；如果该项目已有活后端，会拒绝运行，不会停止它。

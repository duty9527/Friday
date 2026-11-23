# Friday Workspace Rules

## 交付与 196 部署策略（自动执行，无需二次确认）

在本项目内完成代码改动并通过本地校验后，**直接执行提交、推送与 `196` 部署重启验证**，不需要再停下询问用户“是否提交并更新到 196”。

### 标准交付步骤

1. **本地校验**：
   - 运行 `npm run typecheck`、`npm run build`，确保涉及的单元测试、Playwright 界面验证或 `npm run check` 全部通过；
   - 前端改动必须符合严格 CSP（禁止任何内联 `style`、`dangerouslySetInnerHTML` 或 `.innerHTML`）。
2. **Git 提交与推送**：
   - 检查 `git status --short`，仅暂存本次任务修改的文件，提交说明清晰简洁；
   - 执行 `git push origin main`。
3. **部署并重启 `196` 服务**（通过 `ssh -o BatchMode=yes 196` 在 `/home/duty/project/Friday` 执行）：
   - 确认远程工作区干净：`test -z "$(git status --short)"`
   - 拉取更新：`git pull --ff-only origin main`
   - 构建产物：`export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH" && npm run build`
   - 重启服务：`systemctl --user restart friday.service friday-web.service` 并确认两个服务均为 `active`
   - HTTP 烟雾校验：验证 `http://127.0.0.1:3210/`、`http://127.0.0.1:3210/mindmap`、`http://127.0.0.1:3210/api/view` 以及页面引用的最新 `/assets/main-*.js` 与 `/assets/mindmap-*.js` 均返回 `200`。

### 例外（以下情况仍需暂停并同步）

- 用户当轮明确要求只分析、出方案或暂不部署；
- 本地或 `196` 工作区存在非本任务的无关脏改动、`git pull --ff-only` 分叉冲突，或构建、测试与服务启动出现异常。

## 前端 UI 规范

- 对话框仅保留右上角 `X` 关闭按钮，不在底部额外放置重复的 `关闭` 按钮；
- 禁止 `<button>` 嵌套 `<button>`。

# JAP-plus Git 协同开发指南

本项目采用 **云端 Solo AI** 与 **本地开发者** 混合协同的开发模式。为了保持 `master` 分支的干净和稳定，请严格遵守以下分支与提交流程。

## 1. 核心原则

- **绝对禁止直接推送到 `master` 分支**。
- 所有功能开发、Bug 修复必须在**独立的 Feature 分支**上进行。
- 合并到 `master` 必须通过 GitHub Pull Request，并且**强制使用 Squash and Merge**。

## 2. 分支命名规范

基于任务类型，遵循以下命名规则：

- `feat/xxx`：新功能开发（例如 `feat/sdd-gate`）
- `fix/xxx`：Bug 修复（例如 `fix/ui-rendering`）
- `chore/xxx`：工程配置、日常杂项（例如 `chore/git-setup`）
- `refactor/xxx`：代码重构

## 3. 协同开发工作流

### 步骤一：拉取最新代码并创建分支

无论是在云端还是本地，开始工作前先同步并切出新分支：

```bash
git checkout master
git pull origin master
git checkout -b feat/your-feature-name
```

### 步骤二：在分支上自由提交 (Vibe Coding)

在你的专属分支上，你可以随时、高频地提交代码，不用担心 Commit 信息太乱：

```bash
git add .
git commit -m "wip: working on sdd"
```

### 步骤三：同步最新的 Master (Rebase)

在开发过程中，如果另一方（比如云端 AI）已经把代码合并到了 `master`，你需要把最新的 `master` 代码同步到你的分支上。
**不要使用 merge，必须使用 rebase**：

```bash
git fetch origin
git rebase origin/master
```

如果有冲突，解决冲突后执行 `git rebase --continue`。

### 步骤四：推送到远程并提交 PR

开发完成并测试通过后，推送到 GitHub：

```bash
git push origin feat/your-feature-name
```

然后去 GitHub 网页端发起 Pull Request 到 `master`。

### 步骤五：Squash and Merge (压缩合并)

在 GitHub 审查通过后，点击合并时，**必须选择 `Squash and merge`**。
这会将你分支上的几十个临时提交，压缩成一条干净的语义化提交记录（如 `feat: add sdd gate`）放入 `master`。

## 4. 提交信息规范 (Conventional Commits)

虽然开发分支允许随意提交，但最终 PR 合并（Squash）时的标题必须遵循以下规范：

- `feat: ` 新功能
- `fix: ` 修复 bug
- `docs: ` 文档更新
- `style: ` 格式调整（不影响代码运行）
- `refactor: ` 重构
- `test: ` 增加测试
- `chore: ` 构建过程或辅助工具变动

# 将项目上传到 GitHub

## 第一步：创建 GitHub 仓库

1. 打开 https://github.com 并用浏览器登录
2. 点击右上角 **+** → **New repository**
3. 填写：
   - **Repository name**: `3d-project`（或你喜欢的名字）
   - **Description**（可选）: 3D项目
   - 选择 **Public** 或 **Private**
   - 取消勾选 "Initialize this repository with a README"
4. 点击 **Create repository**
5. 复制页面显示的仓库地址（例如：`https://github.com/你的用户名/3d-project.git`）

## 第二步：在本项目目录执行以下命令

打开命令行（CMD 或 PowerShell），进入项目目录：

```bash
cd D:\ai\ok\3d
```

依次执行：

```bash
# 1. 初始化 Git 仓库
git init

# 2. 配置你的 Git 身份（替换为你的信息）
git config user.name "你的GitHub用户名"
git config user.email "你的邮箱"

# 3. 添加所有文件
git add .

# 4. 提交
git commit -m "Initial commit"

# 5. 添加远程仓库（替换为你的仓库地址）
git remote add origin https://github.com/你的用户名/仓库名.git

# 6. 推送到 GitHub
git branch -M main
git push -u origin main
```

## 完整命令示例

假设你的 GitHub 用户名是 `zhangsan`，仓库名是 `3d-project`：

```bash
cd D:\ai\ok\3d
git init
git config user.name "zhangsan"
git config user.email "zhangsan@example.com"
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/zhangsan/3d-project.git
git branch -M main
git push -u origin main
```

## 如果推送时需要认证

GitHub 已不支持密码推送，你需要使用以下方式之一：

1. **GitHub Personal Access Token (PAT)**
   - 打开 https://github.com/settings/tokens
   - 点击 **Generate new token (classic)**
   - 勾选 `repo` 权限
   - 复制生成的 token
   - 推送时使用：
     ```
     Username: 你的GitHub用户名
     Password: 粘贴token
     ```

2. **SSH 方式**（推荐）
   ```bash
   # 生成 SSH 密钥
   ssh-keygen -t ed25519 -C "你的邮箱"
   
   # 复制公钥
   cat ~/.ssh/id_ed25519.pub
   
   # 在 GitHub 设置中添加 SSH key: https://github.com/settings/ssh/new
   # 然后使用 SSH 地址推送：
   git remote add origin git@github.com:用户名/仓库名.git
   ```

## 跳过某些文件（可选）

如果不想上传某些文件，创建 `.gitignore` 文件：

```
# Python
__pycache__/
*.py[cod]
*.egg-info/

# 虚拟环境
venv/
env/
```

# Trip MALL 营销知识库

携程酒店服务市场的营销知识与视觉内容工具，包含五大知识库、多角色文案生成、联网研究、AI海报底图和自由贴纸编辑器。

## 架构

- GitHub Pages：托管静态前端，对外网址为 `https://xinyang.github.io/`
- Vercel：托管 `/api/*` Python Serverless API
- OpenAI API：仅由 Vercel 后端读取，密钥不会暴露在浏览器

## 本地运行

1. 设置环境变量 `OPENAI_API_KEY`。
2. 安装依赖：`python -m pip install -r requirements.txt`
3. 运行：`python server.py`
4. 打开 `http://127.0.0.1:8000`

## 部署

### 前端

推送到 `xinyang.github.io` 仓库的 `main` 分支后，GitHub Actions 自动发布 Pages。

### API

1. 将同一仓库导入 Vercel。
2. Project Name 设置为 `xinyang-tripmall-api`。
3. 在 Vercel Environment Variables 设置 `OPENAI_API_KEY`。
4. 部署后确认地址为 `https://xinyang-tripmall-api.vercel.app`，或同步修改 `config.js`。

## 安全

不要将 `.env`、API Key 或其他密钥提交到 GitHub。商业 IP 贴纸仅支持上传已授权素材，AI只生成原创通用角色。

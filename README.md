# Trip MALL 营销知识库

携程酒店服务市场的营销知识与视觉内容工具：五大知识库、多角色文案生成、
文案学习（上传文案/PPT/链接提炼风格画像）、生成需求、联网研究、
AI海报底图（AI生成/上传/模板）、海报AI学习、多风格贴纸、撤销重做、
草稿、素材一键删除与携程服务市场水印。

## 架构

- GitHub Pages：托管静态前端，对外网址为 `https://xinyangli-326.github.io/test/`
- Vercel：托管 `/api/*` Python Serverless API（WSGI 入口 `api/index.py`）
- OpenAI API：仅由 Vercel 后端读取，密钥不会暴露在浏览器
- 公网 AI 兜底：浏览器端 Puter.js（未配置 API Key 时自动降级）
- 个性化学习：风格画像、学习素材、草稿、偏好标签保存在浏览器 localStorage

## API 端点

- `POST /api/generate` 内容生成（含社群运营、生成需求、风格画像、学习素材）
- `POST /api/poster-copy` 海报短文案
- `POST /api/research` 联网研究
- `POST /api/profile` 从素材提炼文案风格画像
- `POST /api/extract` 解析链接或文件（txt/md/docx/pptx/pdf/html，base64 JSON 上传）
- `POST /api/poster` AI 海报底图
- `POST /api/sticker` AI 贴纸（多风格）
- `POST /api/poster-learn` 上传海报图片，AI 学习风格并返回生成参数
- `GET /api/knowledge` 知识库数据

## 本地运行

1. 设置环境变量 `OPENAI_API_KEY`。
2. 安装依赖：`python -m pip install -r requirements.txt`
3. 运行：`python server.py`
4. 打开 `http://127.0.0.1:8000`

## 部署

### 前端

推送到 `xinyangli-326/test` 仓库的 `main` 分支后，GitHub Actions 自动发布 Pages。

### API

1. 将同一仓库导入 Vercel。
2. Project Name 设置为 `test-xinyang`。
3. 在 Vercel Environment Variables 设置 `OPENAI_API_KEY`。
4. 部署后确认地址为 `https://test-xinyang.vercel.app`，或同步修改 `config.js`。

## 安全

不要将 `.env`、API Key 或其他密钥提交到 GitHub。商业 IP 贴纸仅支持上传已授权素材，
AI 只生成原创通用角色。链接解析拒绝内网地址，避免 SSRF。

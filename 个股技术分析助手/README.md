# 个股技术分析助手

输入 A 股名称或代码，自动读取当日分时、最近 120 个交易日日 K，并结合上证指数、深证成指和对应风格指数，生成趋势、突破质量、量价承接、市场相对强弱及上涨潜力分析。

## 运行要求

- Windows 10/11
- Node.js 18 或更高版本
- 已安装并可正常调用 wind-mcp-skill
- 有效的 Wind 数据访问权限

## Windows 快速启动

双击“启动个股技术分析助手.cmd”，浏览器会自动打开 http://127.0.0.1:8799 。

也可以在终端中运行 npm start（如果自行添加 package.json），或运行 node technical_analysis_server.mjs。

## 数据源配置

后端默认在当前用户目录的 .agents/skills/wind-mcp-skill 下查找 Wind 工具。如果安装位置不同，请设置环境变量 WIND_SKILL_DIR。

项目本身不保存 Wind API Key，认证由本机 Wind 数据工具负责。.env.example 只包含占位符。请勿把真实 API Key、访问令牌、Cookie 或本地认证文件提交到 GitHub；.gitignore 已排除 .env 与本地配置文件。

## 文件说明

- 个股技术分析助手.html：前端页面
- technical_analysis_server.mjs：Node.js 后端与分析逻辑
- 启动个股技术分析助手.cmd：Windows 双击入口
- start_technical_analysis_local.ps1：本机启动脚本

## 免责声明

页面输出属于技术分析辅助信息，不构成投资建议或收益承诺。行情数据的许可范围、使用方式和对外分享应遵守 Wind 数据服务协议。

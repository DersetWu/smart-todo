# Smart Todo

Smart Todo 是一个 Electron 桌面待办 Demo，可以从自然语言中识别待办类型、日期、工作日和循环频率，并在后台按时提醒。

## 主要功能

- 自动将事件归类为碎片、规划或项目
- 支持相对时间、固定时间、工作日及时间区间循环提醒
- 提醒弹窗提取简洁的事件关键词
- 已完成事件历史记录与导出
- 可选的 OpenAI 兼容接口辅助分类
- Windows 便携版和可选择安装目录的安装包

## 本地运行

需要 Node.js 及 npm：

```powershell
npm install
npm start
```

## 测试与打包

```powershell
npm test
npm run build
```

构建结果生成在 `dist/`，该目录不会提交到 GitHub。

## 隐私与安全

- AI Key 不写入源码或仓库；桌面版通过 Electron `safeStorage` 加密后保存在本机用户数据目录。
- 待办事件保存在本地浏览器数据库或 Electron 用户数据目录，不随源码上传。
- 日志、环境变量文件、构建产物和本地 AI 配置均已加入 `.gitignore`。
- 发布前建议再次运行密钥扫描，并检查 Git 暂存区文件清单。

## Windows 安装位置

运行 `npm run build` 会同时生成：

- `SmartTodo.exe`：便携版，无需安装，可放在任意非 C 盘目录运行。
- `Smart Todo Setup 1.0.0.exe`：安装版，安装过程中可手动选择目标目录。

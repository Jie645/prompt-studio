Prompt Studio Standalone 1.1.0

安装：
1. 解压整个安装包。
2. 双击 install.cmd。
3. 桌面会出现 Prompt Studio Standalone 快捷方式。

程序会安装到桌面的 PromptStudio-Standalone 文件夹。
双击 run.cmd 或桌面快捷方式会启动本地代理并打开页面，
这样可以绕过浏览器对云端模型接口的 CORS 限制。

如果电脑没有 Node.js 18+，启动脚本会回退为直接打开 index.html；
此时离线规则可用，但云端接口可能被 CORS 拦截。

卸载：
运行安装目录中的 uninstall.ps1。

本版本为单文件网页，不依赖 Node.js。
API Key 和设置仅保存在本机浏览器中。

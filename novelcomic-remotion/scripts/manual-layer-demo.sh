#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-3034}"

cd "$ROOT_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
	printf '%s\n' '未找到 pnpm，请先安装 pnpm。'
	exit 1
fi

if [ ! -d node_modules ]; then
	printf '%s\n' '当前项目还没有安装依赖，请先运行：'
	printf '%s\n' '  pnpm install'
	exit 1
fi

cat <<EOF

动态漫画手动拆层 Demo
=====================

启动地址：http://localhost:${PORT}

打开页面后按下面操作：

1. 点击左侧“上传”，上传一张漫画图片。
2. 在素材区把图片添加到时间线。
3. 点击左侧“图层”，选中刚添加的原图。
4. 点击左侧“描点拆层”。
5. 在图片上依次点击头发、嘴巴或眼睛的边界。
6. 点击第一个点，或按 Enter，闭合选区。
7. 点击“生成透明图层”。
8. 输入图层名称，例如 hair；语义输入 hair、mouth-open 或 eye-open。
9. 生成后回到“选择”工具，拖动新图层检查是否和原图位置对齐。

快捷操作：
- Enter：闭合选区
- Esc：取消当前描点
- Delete / Backspace：删除当前控制点
- 拖动控制点：修正边界

按 Ctrl+C 停止开发服务器。

EOF

exec pnpm exec next dev --turbopack --port "$PORT"

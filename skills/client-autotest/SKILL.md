---
name: client-autotest
description: Run automated mobile testing on iOS or Android devices. Use when the user asks to run, execute, or automate a mobile test, verify app behavior, or run a test suite.
---

# Client AutoTest

## 行动流程

### 第一步：收集必要信息

从用户描述中提取所需信息，**逐步提问，每次只问一个问题，等用户回答后再问下一个**，顺序如下：

1. **任务**：若用户未说明要测什么，先问"你想测什么功能或场景？"，等待回答。
2. **平台**：若用户未指定平台，再问"请问是在哪个平台上测试？（ios-simulator / ios-real / android）"，等待回答。
3. **bundle_id**（可选）：若用户未提供，可跳过——脚本会自动从 `.autotest.yml` 读取；交互式首次运行会询问并保存，非交互环境会直接跳过（建议显式传 `--bundle-id`）。

> ⚠️ 切勿一次性列出所有问题，必须一问一答、依次推进。

### 第二步：执行测试

脚本内部自动完成：
1. clone / 构建 mobile-mcp
2. 若未传 `--device`，列出设备并提示用户选择
3. 平台专项检查（WDA、ADB 等）
4. 读取 / 初始化 `.autotest.yml` 中的 bundle_id

平台说明：
- `ios-simulator` / `ios-real` 仅支持 macOS 主机
- `android` 支持 macOS / Linux / Windows（需正确安装 adb）

**自然语言任务（最常见，device 和 bundle-id 均可省略）：**
```bash
python3 skills/client-autotest/scripts/run.py \
  --platform <ios-simulator|ios-real|android> \
  --task     "<任务描述>"
```

**指定设备 / bundle-id（可选）：**
```bash
python3 skills/client-autotest/scripts/run.py \
  --platform <ios-simulator|ios-real|android> \
  --device   "<设备ID>" \
  --bundle-id "<bundle_id>" \
  --task     "<任务描述>"
```

**单个任务文件：**
```bash
python3 skills/client-autotest/scripts/run.py \
  --platform <p> [--device <d>] [--bundle-id <b>] --task-file <路径>
```

**批量跑目录下所有任务：**
```bash
python3 skills/client-autotest/scripts/run.py \
  --platform <p> [--device <d>] [--bundle-id <b>] --task-dir <目录>
```

可选参数：
- `--subject <名称>`：结果目录前缀，默认取当前 git 项目名
- `--max-steps <数字>`：默认 50，复杂任务可设到 80-100

### 第三步：展示结果

- 通过 / 失败数量
- 结果目录：当前 git 根目录下 `ClientAutoTestResult/<subject>_<时间戳>/`
- 如有失败，读取对应 `.log` 文件分析原因

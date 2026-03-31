#!/usr/bin/env python3
# Client AutoTest 主入口
#
# 用法：
#   run.py --platform <ios-simulator|ios-real|android>
#          --device <设备ID>
#          --bundle-id <bundle_id>
#          --task "<任务描述>"           # 与 --task-file / --task-dir 三选一
#          --task-file <路径>
#          --task-dir <目录>
#          [--subject <名称>]            # 结果目录名前缀，默认取当前 git 项目名
#          [--max-steps <数字>]          # 默认 50
#   run.py --list-devices               # 列出可用设备

import argparse
import os
import platform
import subprocess
import sys
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
AUTOTEST_CONFIG = ".autotest.yml"
RESULT_ROOT_DIR = "iau_autotest"


def _agent_script() -> Path:
    s = platform.system()
    if s == "Darwin":
        base = Path.home() / "Library" / "Application Support" / "ClientAutoTest"
    elif s == "Linux":
        xdg = os.environ.get("XDG_DATA_HOME")
        base = (Path(xdg) if xdg else Path.home() / ".local" / "share") / "ClientAutoTest"
    else:
        base = Path(os.environ.get("APPDATA", Path.home())) / "ClientAutoTest"
    return base / "mobile-mcp" / "lib" / "agent.js"


AGENT_SCRIPT = _agent_script()

PLATFORM_CHECK = {
    "ios-simulator": "check_ios_sim.py",
    "ios-real":      "check_ios_real.py",
    "android":       "check_android.py",
}


def get_git_root() -> Path:
    result = subprocess.run(
        ["git", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    return Path(result.stdout.strip()) if result.returncode == 0 else Path.cwd()


def run_install():
    print("[准备] 检查 mobile-mcp 工具...")
    subprocess.run(["python3", str(SCRIPT_DIR / "install_repo.py")], check=True)


def list_devices():
    subprocess.run(["node", str(AGENT_SCRIPT), "--list-devices"], check=True)


def check_platform(platform: str, device: str = ""):
    print(f"[准备] 平台环境检查（{platform}）...")
    cmd = ["python3", str(SCRIPT_DIR / PLATFORM_CHECK[platform])]
    if platform == "ios-real" and device:
        cmd += ["--device", device]
    subprocess.run(cmd, check=True)


def ensure_host_os_supported(target_platform: str):
    """按目标平台校验当前主机系统，给出更早、更明确的错误提示。"""
    host_os = platform.system()
    if target_platform in ("ios-simulator", "ios-real") and host_os != "Darwin":
        print(f"错误：{target_platform} 仅支持在 macOS 主机上执行，当前系统为 {host_os}")
        sys.exit(1)


def load_bundle_id_from_config(git_root: Path) -> str:
    """从 .autotest.yml 读取 bundle_id，不存在则返回空字符串。"""
    config_file = git_root / AUTOTEST_CONFIG
    if not config_file.exists():
        return ""
    for line in config_file.read_text().splitlines():
        line = line.strip()
        if line.startswith("bundle_id:"):
            return line.split(":", 1)[1].strip()
    return ""


def save_bundle_id_to_config(git_root: Path, bundle_id: str):
    """将 bundle_id 写入 .autotest.yml，保留文件中其他已有字段。"""
    config_file = git_root / AUTOTEST_CONFIG
    if config_file.exists():
        lines = config_file.read_text().splitlines()
        new_lines = []
        found = False
        for line in lines:
            if line.strip().startswith("bundle_id:"):
                new_lines.append(f"bundle_id: {bundle_id}")
                found = True
            else:
                new_lines.append(line)
        if not found:
            new_lines.append(f"bundle_id: {bundle_id}")
        config_file.write_text("\n".join(new_lines) + "\n")
    else:
        config_file.write_text(f"bundle_id: {bundle_id}\n")
    print(f"[配置] 已保存到 {config_file}")


def resolve_bundle_id(cli_bundle_id: str, git_root: Path, allow_prompt: bool = True) -> str:
    """
    优先级：命令行参数 > .autotest.yml > 交互式询问（可选，且仅在允许时）
    若不允许交互且未提供 bundle_id，则返回空字符串。
    """
    if cli_bundle_id:
        return cli_bundle_id

    saved = load_bundle_id_from_config(git_root)
    if saved:
        print(f"[配置] 使用 {AUTOTEST_CONFIG} 中的 bundle_id：{saved}")
        return saved

    if not allow_prompt:
        print(f"[配置] 未提供 bundle_id，且未找到 {AUTOTEST_CONFIG}，将按任务描述直接执行")
        return ""

    # 首次运行，询问用户
    print(f"\n未找到 {AUTOTEST_CONFIG}，请输入被测应用的 Bundle ID（如 com.example.app）：")
    try:
        bundle_id = input("Bundle ID: ").strip()
    except EOFError:
        print(f"[配置] 当前环境不可交互，跳过 bundle_id；如需指定请使用 --bundle-id 或配置 {AUTOTEST_CONFIG}")
        return ""
    if not bundle_id:
        print("[配置] 未输入 bundle_id，将按任务描述直接执行")
        return ""
    save_bundle_id_to_config(git_root, bundle_id)
    return bundle_id


def select_device() -> str:
    """列出可用设备并让用户选择，返回设备 ID。"""
    print("\n[设备] 正在列出可用设备...\n")
    list_devices()
    print("\n请输入要使用的设备 ID：")
    try:
        device = input("Device ID: ").strip()
    except EOFError:
        print("错误：非交互环境下无法选择设备，请通过 --device 参数传入设备 ID")
        sys.exit(1)
    if not device:
        print("错误：设备 ID 不能为空")
        sys.exit(1)
    return device


def run_single_task(device, bundle_id, task_desc, max_steps, log_file, label, summary_file) -> bool:
    print(f"\n[运行] {label}")
    print("-------")
    print(f"[日志] 实时日志文件：{log_file}")
    print(f"[日志] 可在新终端查看：tail -f {log_file}")

    effective_task = task_desc
    if bundle_id:
        effective_task = f"App bundle ID to test: {bundle_id}. {task_desc}"

    cmd = ["node", str(AGENT_SCRIPT),
           "--device", device,
           "--task", effective_task,
           "--max-steps", str(max_steps)]

    start = datetime.now()
    with open(log_file, "w", buffering=1) as f:
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        if proc.stdout is not None:
            for line in proc.stdout:
                print(line, end="", flush=True)
                f.write(line)
                f.flush()
        proc.wait()

    elapsed = int((datetime.now() - start).total_seconds())
    if proc.returncode == 0:
        summary_file.write(f"[通过] {label}（耗时 {elapsed}s）\n")
        print(f"[通过] {label}")
        return True
    else:
        summary_file.write(f"[失败] {label}（耗时 {elapsed}s，exit={proc.returncode}）\n")
        print(f"[失败] {label}")
        return False


def main():
    parser = argparse.ArgumentParser(prog="run.py")
    parser.add_argument("--platform", choices=list(PLATFORM_CHECK))
    parser.add_argument("--device")
    parser.add_argument("--bundle-id", default="")
    parser.add_argument("--task")
    parser.add_argument("--task-file")
    parser.add_argument("--task-dir")
    parser.add_argument("--subject", default="")
    parser.add_argument("--max-steps", type=int, default=50)
    parser.add_argument("--list-devices", action="store_true")
    args = parser.parse_args()

    if args.list_devices:
        # 仅设备列表场景：无需任务参数，但需要先准备 agent
        run_install()
        list_devices()
        return

    if not args.platform:
        parser.error("--platform 必填（ios-simulator | ios-real | android）")

    if args.max_steps <= 0:
        parser.error("--max-steps 必须为正整数")

    task_sources = [args.task, args.task_file, args.task_dir]
    filled = sum(1 for s in task_sources if s)
    if filled == 0:
        parser.error("--task、--task-file、--task-dir 三者必须指定其一")
    if filled > 1:
        parser.error("--task、--task-file、--task-dir 只能指定一个")

    ensure_host_os_supported(args.platform)

    git_root = get_git_root()

    # 第一步：参数合法后再准备 mobile-mcp，避免错误调用触发重操作
    run_install()

    # 第二步：环境检查（ios-simulator / android 不依赖设备，尽早暴露工具缺失）
    if args.platform != "ios-real":
        check_platform(args.platform)

    # 第三步：确认设备（未传 --device 时列出并让用户选择）
    device = args.device or select_device()

    # 第四步：ios-real 设备专项检查（需要 UDID 安装 WDA）
    if args.platform == "ios-real":
        check_platform(args.platform, device)

    # 第五步：解析 bundle_id（非交互环境下不阻塞）
    allow_prompt = sys.stdin.isatty() and sys.stdout.isatty()
    bundle_id = resolve_bundle_id(args.bundle_id, git_root, allow_prompt=allow_prompt)

    subject = args.subject or git_root.name
    timestamp = datetime.now().strftime("%Y-%m-%dT%H-%M-%S")
    result_dir = git_root / RESULT_ROOT_DIR / f"{subject}_{timestamp}"
    result_dir.mkdir(parents=True, exist_ok=True)

    print()
    print("======================================")
    print(" Client AutoTest")
    print(f" 平台：{args.platform}  设备：{device}")
    print("======================================")
    print(f"[结果] 输出目录：{result_dir}")

    passed = 0
    failed = 0

    with open(result_dir / "run-summary.txt", "w") as summary:
        summary.write(f"测试主体：{subject}\n")
        summary.write(f"平台：{args.platform}\n")
        summary.write(f"设备：{device}\n")
        if bundle_id:
            summary.write(f"Bundle ID：{bundle_id}\n")
        summary.write(f"开始时间：{datetime.now()}\n")
        summary.write("---\n")

        def run_task(task_desc, log_name, label):
            nonlocal passed, failed
            ok = run_single_task(
                device, bundle_id, task_desc, args.max_steps,
                result_dir / log_name, label, summary)
            if ok:
                passed += 1
            else:
                failed += 1

        if args.task:
            run_task(args.task, "inline-task.log", "inline-task")

        elif args.task_file:
            tf = Path(args.task_file)
            if not tf.is_file():
                print(f"错误：任务文件不存在：{tf}")
                sys.exit(1)
            run_task(tf.read_text().strip(), f"{tf.name}.log", tf.name)

        elif args.task_dir:
            td = Path(args.task_dir)
            if not td.is_dir():
                print(f"错误：任务目录不存在：{td}")
                sys.exit(1)
            task_files = sorted(td.glob("*.txt"))
            if not task_files:
                print(f"错误：目录中没有 .txt 任务文件：{td}")
                sys.exit(1)
            print(f"[运行] 发现 {len(task_files)} 个任务文件，串行执行...")
            for tf in task_files:
                run_task(tf.read_text().strip(), f"{tf.name}.log", tf.name)

        summary.write(f"\n结束时间：{datetime.now()}\n")
        summary.write(f"通过：{passed}  失败：{failed}\n")

    print()
    print("======================================")
    print(" 测试完成")
    print(f" 通过：{passed}  失败：{failed}")
    print(f" 结果目录：{result_dir}")
    print("======================================")

    sys.exit(1 if failed > 0 else 0)


if __name__ == "__main__":
    main()

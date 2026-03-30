#!/usr/bin/env python3
# 检查 iOS 模拟器环境
# 需要：macOS + Xcode CLI Tools + 至少一个模拟器已 Boot

import subprocess
import sys


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def main():
    print("[ios-sim] 检查 Xcode CLI Tools...")
    result = run(["xcode-select", "-p"])
    if result.returncode != 0:
        print("[错误] Xcode CLI Tools 未安装")
        print("  安装命令：xcode-select --install")
        sys.exit(1)
    print(f"[ios-sim] Xcode 路径：{result.stdout.strip()}")

    print("[ios-sim] 检查 xcrun simctl...")
    if run(["xcrun", "simctl", "list"]).returncode != 0:
        print("[错误] xcrun simctl 不可用，请确认 Xcode 安装完整")
        sys.exit(1)

    booted = run(["xcrun", "simctl", "list", "devices", "booted"])
    booted_lines = [l for l in booted.stdout.splitlines() if "Booted" in l]
    if not booted_lines:
        print()
        print("[错误] 当前没有已启动的模拟器，请先启动一个后重新运行")
        print()
        print("可用的 iPhone 模拟器：")
        avail = run(["xcrun", "simctl", "list", "devices", "available"])
        for line in [l for l in avail.stdout.splitlines() if "iPhone" in l][:10]:
            print(line)
        print()
        print("启动模拟器命令示例：")
        print('  xcrun simctl boot "iPhone 16 Pro"')
        print("  open -a Simulator")
        sys.exit(1)
    else:
        print(f"[ios-sim] 已检测到 {len(booted_lines)} 个运行中的模拟器：")
        for line in booted_lines:
            print(line)

    print("[ios-sim] iOS 模拟器环境检查完成")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
# 检查 Android 环境
# 需要：Android Platform Tools（adb）+ 设备已连接/模拟器已启动

import subprocess
import sys


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def main():
    print("[android] 检查 adb...")
    if run(["which", "adb"]).returncode != 0:
        print("[错误] adb 未安装")
        print()
        print("  安装方式：")
        print("  macOS：brew install android-platform-tools")
        print("  Linux：sudo apt install android-tools-adb")
        print("  或手动下载：https://developer.android.com/tools/releases/platform-tools")
        sys.exit(1)
    version = run(["adb", "version"]).stdout.splitlines()[0]
    print(f"[android] adb：{version}")

    print("[android] 检查已连接设备...")
    run(["adb", "start-server"])
    devices_out = run(["adb", "devices"]).stdout
    devices = [l for l in devices_out.splitlines() if l.endswith("\tdevice")]
    unauthorized = [l for l in devices_out.splitlines() if "unauthorized" in l]

    if unauthorized:
        print('[警告] 以下设备待授权（请在设备上点击"允许USB调试"）：')
        for line in unauthorized:
            print(line)

    if not devices:
        print()
        print("[错误] 当前没有可用的 Android 设备或模拟器")
        print()
        print("  真机：在手机「设置 → 开发者选项」中开启 USB 调试，然后用 USB 连接")
        print("  模拟器：通过 Android Studio AVD Manager 启动，或执行：")
        print("    emulator -avd <avd-name>")
        print()
        print("  查看可用 AVD：")
        avd = run(["emulator", "-list-avds"])
        print(avd.stdout if avd.returncode == 0 else "  （emulator 命令不在 PATH 中）")
        sys.exit(1)
    else:
        print("[android] 已连接设备：")
        for line in devices:
            print(line)

    print("[android] Android 环境检查完成")


if __name__ == "__main__":
    main()

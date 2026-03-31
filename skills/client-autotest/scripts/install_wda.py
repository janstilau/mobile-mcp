#!/usr/bin/env python3
# 下载并安装 WebDriverAgent 到 iOS 真机
# 用法：install_wda.py <device-udid>

import argparse
import platform
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

WDA_DOWNLOAD_URL = "http://10.234.49.35:18765/getipa"
WDA_PORT = 8100


def _install_dir() -> Path:
    s = platform.system()
    if s == "Darwin":
        return Path.home() / "Library" / "Application Support" / "ClientAutoTest"
    elif s == "Linux":
        xdg = os.environ.get("XDG_DATA_HOME")
        return (Path(xdg) if xdg else Path.home() / ".local" / "share") / "ClientAutoTest"
    else:
        return Path(os.environ.get("APPDATA", Path.home())) / "ClientAutoTest"


WDA_IPA = _install_dir() / "WebDriverAgent.ipa"


def port_open(port: int) -> bool:
    try:
        with socket.create_connection(("localhost", port), timeout=1):
            return True
    except OSError:
        return False


def wait_for_port(port: int, timeout_sec: int = 5) -> bool:
    deadline = time.time() + timeout_sec
    while time.time() < deadline:
        if port_open(port):
            return True
        time.sleep(0.5)
    return port_open(port)


def main():
    if platform.system() != "Darwin":
        print(f"[错误] install_wda.py 仅支持在 macOS 上运行，当前系统：{platform.system()}")
        sys.exit(1)

    parser = argparse.ArgumentParser(prog="install_wda.py")
    parser.add_argument("device_udid", help="目标 iOS 真机 UDID")
    args = parser.parse_args()
    device_udid = args.device_udid

    # 1. 下载 WDA IPA
    if not WDA_IPA.exists():
        print("[wda] 从内网下载 WebDriverAgent...")
        print(f"[wda] 地址：{WDA_DOWNLOAD_URL}")
        WDA_IPA.parent.mkdir(parents=True, exist_ok=True)
        result = subprocess.run(
            ["curl", "-L", "--max-time", "60", "--fail", "-o", str(WDA_IPA), WDA_DOWNLOAD_URL])
        if result.returncode != 0:
            print("[错误] WDA 下载失败")
            print(f"  请确认内网地址可访问：{WDA_DOWNLOAD_URL}")
            WDA_IPA.unlink(missing_ok=True)
            sys.exit(1)
        print(f"[wda] 下载完成：{WDA_IPA}")
    else:
        print(f"[wda] WDA IPA 已存在，跳过下载：{WDA_IPA}")

    # 2. 安装 WDA 到设备
    print(f"[wda] 安装 WebDriverAgent 到设备 {device_udid} ...")
    subprocess.run(
        ["ios", "install", "--path", str(WDA_IPA), "--udid", device_udid], check=True)
    print("[wda] 安装完成")

    # 3. 端口转发（幂等处理，避免重复拉起后台进程）
    if port_open(WDA_PORT):
        print(f"[wda] 检测到 localhost:{WDA_PORT} 已可访问，跳过重复端口转发")
    else:
        print(f"[wda] 启动端口转发（设备:{WDA_PORT} → localhost:{WDA_PORT}）...")
        with open("/tmp/wda-forward.log", "w") as log_f:
            subprocess.Popen(
                ["ios", "forward", str(WDA_PORT), str(WDA_PORT), "--udid", device_udid],
                stdout=log_f, stderr=subprocess.STDOUT)
        if wait_for_port(WDA_PORT, timeout_sec=5):
            print("[wda] 端口转发已在后台启动并可访问")
        else:
            print("[警告] 端口转发进程已启动，但端口暂不可访问，请检查日志：/tmp/wda-forward.log")

    # 4. 提示手动启动
    print()
    print("======================================")
    print(" 请在手机上手动启动 WebDriverAgentRunner 应用")
    print(" 启动时手机会提示输入密码，属于正常行为")
    print(" 启动后用以下命令验证是否就绪：")
    print(f"   curl http://localhost:{WDA_PORT}/status")
    print("======================================")


if __name__ == "__main__":
    main()

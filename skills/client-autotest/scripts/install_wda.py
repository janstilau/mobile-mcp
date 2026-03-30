#!/usr/bin/env python3
# 下载并安装 WebDriverAgent 到 iOS 真机
# 用法：install_wda.py <device-udid>

import platform
import os
import subprocess
import sys
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


def main():
    if len(sys.argv) < 2 or not sys.argv[1]:
        print("[错误] 需要传入设备 UDID")
        print("  用法：install_wda.py <device-udid>")
        sys.exit(1)
    device_udid = sys.argv[1]

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
        ["ios", "install", "--bundle", str(WDA_IPA), "--udid", device_udid], check=True)
    print("[wda] 安装完成")

    # 3. 端口转发
    print(f"[wda] 启动端口转发（设备:{WDA_PORT} → localhost:{WDA_PORT}）...")
    with open("/tmp/wda-forward.log", "w") as log_f:
        subprocess.Popen(
            ["ios", "forward", str(WDA_PORT), str(WDA_PORT), "--udid", device_udid],
            stdout=log_f, stderr=subprocess.STDOUT)
    print("[wda] 端口转发已在后台启动")

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

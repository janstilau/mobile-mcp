#!/usr/bin/env python3
# 检查 iOS 真机环境
# 需要：go-ios + WebDriverAgent + iOS Tunnel（iOS 17+）
#
# 用法：check_ios_real.py [--device <udid>]
#   --device  指定目标设备 UDID（不传则取第一台已连接设备）

import argparse
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

WDA_PORT = 8100
TUNNEL_PORT = 60105


def cmd_exists(name):
    return subprocess.run(["which", name], capture_output=True).returncode == 0


def port_open(port):
    try:
        with socket.create_connection(("localhost", port), timeout=1):
            return True
    except OSError:
        return False


def get_connected_devices() -> list[dict]:
    """返回已连接设备列表，每项含 udid 字段。"""
    result = subprocess.run(["ios", "list"], capture_output=True, text=True)
    raw = result.stdout.strip()
    if not raw:
        return []
    try:
        data = json.loads(raw)
        # go-ios 输出格式：[{"udid": "...", ...}, ...]  或  {"deviceList": [...]}
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and "deviceList" in data:
            return data["deviceList"]
    except json.JSONDecodeError:
        # 兼容极少数旧版本纯文本输出（每行第一列为 UDID）
        devices = []
        for line in raw.splitlines():
            parts = line.split()
            if parts:
                devices.append({"udid": parts[0]})
        return devices
    return []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="")
    args = parser.parse_args()

    # 1. go-ios
    print("[ios-real] 检查 go-ios...")
    if not cmd_exists("ios"):
        print("[ios-real] go-ios 未安装，正在安装...")
        subprocess.run(["npm", "install", "-g", "go-ios"], check=True)
        if not cmd_exists("ios"):
            print("[错误] go-ios 安装失败，请手动安装：npm install -g go-ios")
            sys.exit(1)
    version = subprocess.check_output(
        ["ios", "version"], stderr=subprocess.STDOUT).decode().splitlines()[0]
    print(f"[ios-real] go-ios 已安装：{version}")

    # 2. 检查已连接设备
    print("[ios-real] 检查已连接的 iOS 设备...")
    devices = get_connected_devices()
    if not devices:
        print("[错误] 未检测到已连接的 iOS 设备")
        print("  请确认：")
        print("  1. 设备已通过 USB 连接")
        print("  2. 设备已信任此电脑")
        sys.exit(1)

    udids = [d.get("udid", "") for d in devices if d.get("udid")]
    print(f"[ios-real] 已连接设备：{udids}")

    if args.device:
        if args.device not in udids:
            print(f"[错误] 指定设备 {args.device} 未在已连接列表中：{udids}")
            sys.exit(1)
        device_udid = args.device
    else:
        device_udid = udids[0]
    print(f"[ios-real] 目标设备：{device_udid}")

    # 3. iOS Tunnel（iOS 17+ 必须）
    print(f"[ios-real] 检查 iOS Tunnel（端口 {TUNNEL_PORT}）...")
    if port_open(TUNNEL_PORT):
        print("[ios-real] iOS Tunnel 正在运行")
    else:
        print("[ios-real] iOS Tunnel 未运行，尝试在后台启动...")
        with open("/tmp/ios-tunnel.log", "w") as log_f:
            subprocess.Popen(["ios", "tunnel", "start"],
                             stdout=log_f, stderr=subprocess.STDOUT)
        time.sleep(3)
        if port_open(TUNNEL_PORT):
            print("[ios-real] iOS Tunnel 启动成功")
        else:
            print("[警告] iOS Tunnel 启动失败，日志：/tmp/ios-tunnel.log")
            print("  iOS 17+ 真机需要 Tunnel 才能转发端口，请手动运行：ios tunnel start")
            print("  iOS 16 及以下无需 Tunnel，继续执行...")

    # 4. WebDriverAgent
    print(f"[ios-real] 检查 WebDriverAgent（端口 {WDA_PORT}）...")
    wda_ready = False
    try:
        import urllib.request
        with urllib.request.urlopen(f"http://localhost:{WDA_PORT}/status", timeout=3) as resp:
            if b'"ready":true' in resp.read():
                wda_ready = True
    except Exception:
        pass

    if wda_ready:
        print("[ios-real] WebDriverAgent 正在运行")
    else:
        print("[ios-real] WebDriverAgent 未运行，开始安装...")
        subprocess.run(
            ["python3", str(Path(__file__).parent / "install_wda.py"), device_udid],
            check=True)

    print("[ios-real] iOS 真机环境检查完成")


if __name__ == "__main__":
    main()

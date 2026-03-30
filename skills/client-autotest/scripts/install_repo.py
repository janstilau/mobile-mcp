#!/usr/bin/env python3
# 克隆 mobile-mcp 仓库并构建

import platform
import os
import subprocess
import sys
from pathlib import Path

REPO_URL = "git@gitlab.corp.youdao.com:luna-dev/yd_mobile_mcp_agent.git"
REPO_BRANCH = "main"


def _install_dir() -> Path:
    s = platform.system()
    if s == "Darwin":
        return Path.home() / "Library" / "Application Support" / "ClientAutoTest"
    elif s == "Linux":
        xdg = os.environ.get("XDG_DATA_HOME")
        return (Path(xdg) if xdg else Path.home() / ".local" / "share") / "ClientAutoTest"
    else:
        return Path(os.environ.get("APPDATA", Path.home())) / "ClientAutoTest"


INSTALL_DIR = _install_dir()
REPO_DIR = INSTALL_DIR / "mobile-mcp"
AGENT_SCRIPT = REPO_DIR / "lib" / "agent.js"


def run(cmd, **kwargs):
    subprocess.run(cmd, check=True, **kwargs)


def main():
    INSTALL_DIR.mkdir(parents=True, exist_ok=True)

    if not (REPO_DIR / ".git").exists():
        print(f"[repo] 克隆仓库 {REPO_URL} ...")
        run(["git", "clone", REPO_URL, str(REPO_DIR),
             "--branch", REPO_BRANCH, "--single-branch", "--depth", "1"])
        print("[repo] 克隆完成")
    else:
        print("[repo] 仓库已存在，检查更新...")
        local_hash = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=REPO_DIR).decode().strip()
        run(["git", "fetch", "origin", REPO_BRANCH, "--depth", "1", "--quiet"], cwd=REPO_DIR)
        remote_hash = subprocess.check_output(
            ["git", "rev-parse", f"origin/{REPO_BRANCH}"], cwd=REPO_DIR).decode().strip()
        if local_hash != remote_hash:
            print("[repo] 发现新提交，拉取更新...")
            run(["git", "fetch", "--depth", "1", "origin", REPO_BRANCH], cwd=REPO_DIR)
            # 检查是否有本地改动，有则跳过覆盖并提示
            dirty = subprocess.run(
                ["git", "status", "--porcelain"], capture_output=True, text=True, cwd=REPO_DIR
            ).stdout.strip()
            if dirty:
                print("[repo] 检测到本地改动，跳过自动更新以防覆盖：")
                for line in dirty.splitlines():
                    print(f"  {line}")
                print(f"  如需更新，请手动执行：git -C {REPO_DIR} reset --hard origin/{REPO_BRANCH}")
            else:
                run(["git", "reset", "--hard", f"origin/{REPO_BRANCH}"], cwd=REPO_DIR)
                AGENT_SCRIPT.unlink(missing_ok=True)
        else:
            print(f"[repo] 已是最新版本（{local_hash}）")

    if not AGENT_SCRIPT.exists():
        print("[build] 正在构建 mobile-mcp...")
        run(["npm", "install", "--include=optional", "--silent"], cwd=REPO_DIR)
        run(["npm", "run", "build"], cwd=REPO_DIR)
        print(f"[build] 构建完成：{AGENT_SCRIPT}")
    else:
        print("[build] 已构建，跳过")


if __name__ == "__main__":
    main()
